import { integer, pgTable, real, serial, text, timestamp } from "drizzle-orm/pg-core";

export const projects = pgTable("projects", {
  id: text().primaryKey(),
  name: text().notNull(),
  description: text().notNull().default(""),
  status: text().notNull().default("draft"),
  baseModel: text("base_model").notNull().default("claude-sonnet-5-5"),
  temperature: real().notNull().default(0.7),
  dataset: text().notNull().default(""),
  exampleCount: integer("example_count").notNull().default(0),
  epochs: integer().notNull().default(1),
  modelCard: text("model_card").notNull().default(""),
  systemPrompt: text("system_prompt").notNull().default(""),
  trainedAt: timestamp("trained_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const messages = pgTable("messages", {
  id: serial().primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  role: text().notNull(),
  content: text().notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
