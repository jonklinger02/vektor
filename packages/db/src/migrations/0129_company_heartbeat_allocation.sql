CREATE TABLE "company_heartbeat_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"processors" integer DEFAULT 1 NOT NULL,
	"memory" integer DEFAULT 1 NOT NULL,
	"trust" integer DEFAULT 2 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_dispatch_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_heartbeat_configs_company_id_unique" UNIQUE("company_id")
);
--> statement-breakpoint
ALTER TABLE "company_heartbeat_configs" ADD CONSTRAINT "company_heartbeat_configs_company_id_companies_id_fk"
	FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "scheduler_ticks" ADD COLUMN "skipped_allocation" integer DEFAULT 0 NOT NULL;
