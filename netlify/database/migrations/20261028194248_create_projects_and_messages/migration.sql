CREATE TABLE "messages" (
	"id" serial PRIMARY KEY,
	"project_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"base_model" text DEFAULT 'claude-sonnet-5-5' NOT NULL,
	"temperature" real DEFAULT 0.7 NOT NULL,
	"dataset" text DEFAULT '' NOT NULL,
	"example_count" integer DEFAULT 0 NOT NULL,
	"epochs" integer DEFAULT 1 NOT NULL,
	"model_card" text DEFAULT '' NOT NULL,
	"system_prompt" text DEFAULT '' NOT NULL,
	"trained_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_project_id_projects_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE;