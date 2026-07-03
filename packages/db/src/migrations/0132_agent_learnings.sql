CREATE TABLE "agent_learnings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"source_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_learnings" ADD CONSTRAINT "agent_learnings_company_id_companies_id_fk"
	FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_learnings_agent_content_hash_uq" ON "agent_learnings" USING btree ("agent_id","content_hash");
--> statement-breakpoint
CREATE INDEX "agent_learnings_company_agent_created_idx" ON "agent_learnings" USING btree ("company_id","agent_id","created_at");
