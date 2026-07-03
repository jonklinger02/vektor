CREATE TABLE "routing_config_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_class" text NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"model_specs" jsonb NOT NULL,
	"canary_percent" integer,
	"previous_version_id" uuid,
	"created_by_user_id" text,
	"promoted_at" timestamp with time zone,
	"frozen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "routing_config_versions_class_version_idx" ON "routing_config_versions" USING btree ("task_class","version");
--> statement-breakpoint
CREATE INDEX "routing_config_versions_class_status_idx" ON "routing_config_versions" USING btree ("task_class","status");
--> statement-breakpoint
CREATE UNIQUE INDEX "routing_config_versions_one_active_idx" ON "routing_config_versions" ("task_class") WHERE "status" IN ('active','frozen');
--> statement-breakpoint
CREATE UNIQUE INDEX "routing_config_versions_one_canary_idx" ON "routing_config_versions" ("task_class") WHERE "status" = 'canary';
--> statement-breakpoint
CREATE TABLE "routing_decision_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"heartbeat_run_id" uuid,
	"issue_id" uuid,
	"adapter_type" text NOT NULL,
	"task_class" text NOT NULL,
	"routing_config_version_id" uuid,
	"canary_bucket" boolean DEFAULT false NOT NULL,
	"model" text NOT NULL,
	"capped" boolean DEFAULT false NOT NULL,
	"reasoning" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "routing_decision_audit_company_created_idx" ON "routing_decision_audit" USING btree ("company_id","created_at");
