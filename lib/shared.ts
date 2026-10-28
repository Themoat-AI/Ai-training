import { projects } from "../db/schema.js";

export const BASE_MODELS = [
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", tier: "Balanced" },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", tier: "Frontier" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", tier: "Fast" },
] as const;

export const DEFAULT_MODEL = BASE_MODELS[0].id;
export const DISTILL_MODEL = "claude-haiku-5-5";
export const MAX_DATASET_CHARS = 120_000;

export function isBaseModel(value: unknown): value is string {
  return BASE_MODELS.some((m) => m.id === value);
}

export function slugify(value: string) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 40);
  return slug || "project";
}

export function countExamples(dataset: string) {
  const blocks = dataset.split(/\n\s*\n/).filter((b) => b.trim());
  const lines = dataset.split("\n").filter((l) => l.trim());
  return Math.max(blocks.length > 1 ? blocks.length : lines.length, dataset.trim() ? 1 : 0);
}

type ProjectRow = typeof projects.$inferSelect;

export function toPublicProject(row: ProjectRow, { includeDataset = false } = {}) {
  let modelCard: unknown = null;
  try {
    modelCard = row.modelCard ? JSON.parse(row.modelCard) : null;
  } catch {
    modelCard = null;
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    baseModel: row.baseModel,
    temperature: row.temperature,
    exampleCount: row.exampleCount,
    datasetChars: row.dataset.length,
    epochs: row.epochs,
    modelCard,
    trainedAt: row.trainedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(includeDataset ? { dataset: row.dataset } : {}),
  };
}

export function jsonError(message: string, status = 400) {
  return Response.json({ detail: message }, { status });
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
