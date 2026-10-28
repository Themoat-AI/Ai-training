import type { Config, Context } from "@netlify/functions";
import { asc, desc, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { messages, projects } from "../../db/schema.js";
import {
  BASE_MODELS,
  DEFAULT_MODEL,
  isBaseModel,
  jsonError,
  readJson,
  slugify,
  toPublicProject,
} from "../../lib/shared.js";

export default async (req: Request, context: Context) => {
  const id = context.params.id;
  const isMessagesRoute = new URL(req.url).pathname.endsWith("/messages");

  if (!id) {
    if (req.method === "GET") {
      const rows = await db.select().from(projects).orderBy(desc(projects.updatedAt));
      return Response.json({ projects: rows.map((r) => toPublicProject(r)), models: BASE_MODELS });
    }

    if (req.method === "POST") {
      const body = await readJson(req);
      const name = String(body.name ?? "").trim().slice(0, 80);
      const description = String(body.description ?? "").trim().slice(0, 400);
      if (!name) return jsonError("Project name is required");

      const baseModel = isBaseModel(body.baseModel) ? body.baseModel : DEFAULT_MODEL;
      const [row] = await db
        .insert(projects)
        .values({
          id: `${slugify(name)}-${crypto.randomUUID().slice(0, 8)}`,
          name,
          description,
          baseModel,
        })
        .returning();
      return Response.json({ project: toPublicProject(row) }, { status: 201 });
    }

    return jsonError("Method not allowed", 405);
  }

  const [row] = await db.select().from(projects).where(eq(projects.id, id));
  if (!row) return jsonError("Project not found", 404);

  if (isMessagesRoute) {
    if (req.method === "DELETE") {
      await db.delete(messages).where(eq(messages.projectId, id));
      return new Response(null, { status: 204 });
    }
    return jsonError("Method not allowed", 405);
  }

  if (req.method === "GET") {
    const history = await db
      .select({ role: messages.role, content: messages.content, createdAt: messages.createdAt })
      .from(messages)
      .where(eq(messages.projectId, id))
      .orderBy(asc(messages.id));
    return Response.json({ project: toPublicProject(row, { includeDataset: true }), messages: history });
  }

  if (req.method === "PATCH") {
    const body = await readJson(req);
    const updates: Partial<typeof projects.$inferInsert> = { updatedAt: new Date() };
    if (typeof body.name === "string" && body.name.trim()) updates.name = body.name.trim().slice(0, 80);
    if (typeof body.description === "string") updates.description = body.description.trim().slice(0, 400);
    if (isBaseModel(body.baseModel)) updates.baseModel = body.baseModel;
    if (typeof body.temperature === "number" && Number.isFinite(body.temperature)) {
      updates.temperature = Math.min(1, Math.max(0, body.temperature));
    }
    const [updated] = await db.update(projects).set(updates).where(eq(projects.id, id)).returning();
    return Response.json({ project: toPublicProject(updated) });
  }

  if (req.method === "DELETE") {
    await db.delete(projects).where(eq(projects.id, id));
    return new Response(null, { status: 204 });
  }

  return jsonError("Method not allowed", 405);
};

export const config: Config = {
  path: ["/api/projects", "/api/projects/:id", "/api/projects/:id/messages"],
};
