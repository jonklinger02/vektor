CREATE TABLE "refinery_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" text NOT NULL,
	"title" text DEFAULT 'New session' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"model" text,
	"finalized_kind" text,
	"finalized_entity_id" uuid,
	"finalized_company_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refinery_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"role" text NOT NULL,
	"body" text NOT NULL,
	"model" text,
	"context_excluded" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "refinery_sessions" ADD CONSTRAINT "refinery_sessions_owner_user_id_user_id_fk"
	FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "refinery_messages" ADD CONSTRAINT "refinery_messages_session_id_refinery_sessions_id_fk"
	FOREIGN KEY ("session_id") REFERENCES "public"."refinery_sessions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "refinery_sessions_owner_idx" ON "refinery_sessions" USING btree ("owner_user_id","updated_at");
--> statement-breakpoint
CREATE INDEX "refinery_messages_session_idx" ON "refinery_messages" USING btree ("session_id","created_at");
