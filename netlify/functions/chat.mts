import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "@netlify/functions";
import { desc, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { messages, projects } from "../../db/schema.js";
import { jsonError, readJson } from "../../lib/shared.js";

const HISTORY_LIMIT = 20;
const KNOWLEDGE_CHARS = 60_000;

export default async (req: Request) => {
  if (req.method !== "POST") return jsonError("Method not allowed", 405);

  const body = await readJson(req);
  const projectId = String(body.projectId ?? "").trim();
  const prompt = String(body.prompt ?? "").trim().slice(0, 8000);
  if (!prompt) return jsonError("Prompt is required");

  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) return jsonError("Project not found", 404);
  if (project.status !== "trained" || !project.systemPrompt) {
    return jsonError("Train this model before chatting with it");
  }

  const recent = await db
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(eq(messages.projectId, projectId))
    .orderBy(desc(messages.id))
    .limit(HISTORY_LIMIT);
  const history = recent.reverse().filter((m) => m.role === "user" || m.role === "assistant");
  // The API requires the conversation to open with a user turn.
  while (history.length && history[0].role !== "user") history.shift();

  await db.insert(messages).values({ projectId, role: "user", content: prompt });

  const anthropic = new Anthropic();
  const stream = anthropic.messages.stream({
    model: project.baseModel,
    max_tokens: 2048,
    temperature: project.temperature,
    system: `${project.systemPrompt}\n\nReference training data (use it as ground truth):\n<training_data>\n${project.dataset.slice(0, KNOWLEDGE_CHARS)}\n</training_data>`,
    messages: [
      ...history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
      { role: "user", content: prompt },
    ],
  });

  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      async start(controller) {
        let reply = "";
        try {
          for await (const event of stream) {
            if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
              reply += event.delta.text;
              controller.enqueue(encoder.encode(event.delta.text));
            }
          }
        } catch (error) {
          console.error("Chat stream failed", error);
          const note = "\n\n[The model stopped responding. Please try again.]";
          reply += note;
          controller.enqueue(encoder.encode(note));
        }
        if (reply.trim()) {
          await db.insert(messages).values({ projectId, role: "assistant", content: reply });
        }
        controller.close();
      },
    }),
    { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } },
  );
};

export const config: Config = {
  path: "/api/chat",
};
