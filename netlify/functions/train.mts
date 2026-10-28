import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "@netlify/functions";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { projects } from "../../db/schema.js";
import {
  DISTILL_MODEL,
  MAX_DATASET_CHARS,
  countExamples,
  jsonError,
  readJson,
  toPublicProject,
} from "../../lib/shared.js";

const PROFILE_TOOL: Anthropic.Tool = {
  name: "save_model_profile",
  description: "Save the trained model profile distilled from the dataset.",
  input_schema: {
    type: "object",
    properties: {
      summary: { type: "string", description: "One or two sentences describing what this model is for." },
      persona: { type: "string", description: "Who the model is, in a short phrase." },
      tone: { type: "string", description: "Voice and style the model should use." },
      skills: { type: "array", items: { type: "string" }, description: "3-8 concrete capabilities." },
      knowledge: { type: "array", items: { type: "string" }, description: "3-10 key facts or rules from the dataset." },
      guardrails: { type: "array", items: { type: "string" }, description: "Things the model must avoid." },
      starterPrompts: { type: "array", items: { type: "string" }, description: "3-4 example questions a user could ask." },
      systemPrompt: {
        type: "string",
        description: "The complete system prompt that makes a base model behave like the trained model.",
      },
      qualityScore: {
        type: "integer",
        description: "0-100 estimate of how well the profile covers the dataset's knowledge and style.",
      },
    },
    required: ["summary", "persona", "tone", "skills", "knowledge", "guardrails", "starterPrompts", "systemPrompt", "qualityScore"],
  },
};

export default async (req: Request) => {
  if (req.method !== "POST") return jsonError("Method not allowed", 405);

  const body = await readJson(req);
  const projectId = String(body.projectId ?? "").trim();
  const totalPasses = Math.min(3, Math.max(1, Number(body.epochs) || 1));
  const pass = Math.min(totalPasses, Math.max(1, Number(body.pass) || 1));

  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) return jsonError("Project not found", 404);

  let dataset = project.dataset;
  if (pass === 1) {
    dataset = String(body.datasetText ?? "").trim().slice(0, MAX_DATASET_CHARS);
    if (!dataset) return jsonError("Add training data before training");
    await db
      .update(projects)
      .set({
        dataset,
        exampleCount: countExamples(dataset),
        epochs: totalPasses,
        status: "training",
        updatedAt: new Date(),
      })
      .where(eq(projects.id, projectId));
  }

  const previous = pass > 1 && project.modelCard ? project.modelCard : "";
  const instructions = previous
    ? `This is refinement pass ${pass} of ${totalPasses}. Here is the current profile:\n<current_profile>\n${previous}\n</current_profile>\nCompare it against the dataset, fill gaps in knowledge and style, tighten the system prompt, and re-score quality honestly.`
    : `This is pass 1 of ${totalPasses}. Distill the dataset into a complete model profile.`;

  try {
    const anthropic = new Anthropic();
    const result = await anthropic.messages.create({
      model: DISTILL_MODEL,
      max_tokens: 4000,
      tools: [PROFILE_TOOL],
      tool_choice: { type: "tool", name: PROFILE_TOOL.name },
      system:
        "You are a model-training engine. You turn a user's training dataset into a precise model profile whose system prompt makes a general model behave like a custom model fine-tuned on that data. Capture facts, terminology, formats, and voice from the data. Never invent facts that are not in the dataset.",
      messages: [
        {
          role: "user",
          content: `Project: ${project.name}\nGoal: ${project.description || "(not specified)"}\n\n<dataset>\n${dataset}\n</dataset>\n\n${instructions}`,
        },
      ],
    });

    const toolUse = result.content.find((block) => block.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") throw new Error("The training engine returned no profile");
    const profile = toolUse.input as Record<string, unknown>;
    const isFinal = pass === totalPasses;

    const [updated] = await db
      .update(projects)
      .set({
        modelCard: JSON.stringify({ ...profile, pass, totalPasses }),
        systemPrompt: String(profile.systemPrompt ?? ""),
        status: isFinal ? "trained" : "training",
        trainedAt: isFinal ? new Date() : project.trainedAt,
        updatedAt: new Date(),
      })
      .where(eq(projects.id, projectId))
      .returning();

    return Response.json({ project: toPublicProject(updated), pass, totalPasses, done: isFinal });
  } catch (error) {
    console.error("Training failed", error);
    await db.update(projects).set({ status: "failed", updatedAt: new Date() }).where(eq(projects.id, projectId));
    return jsonError(`Training failed: ${error instanceof Error ? error.message : "unknown error"}`, 500);
  }
};

export const config: Config = {
  path: "/api/train",
};
