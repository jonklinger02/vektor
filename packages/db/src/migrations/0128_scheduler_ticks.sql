CREATE TABLE "scheduler_ticks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"interval_ms" integer NOT NULL,
	"duration_ms" integer NOT NULL,
	"lapsed" boolean DEFAULT false NOT NULL,
	"timers_enqueued" integer DEFAULT 0 NOT NULL,
	"routines_triggered" integer DEFAULT 0 NOT NULL,
	"retries_promoted" integer DEFAULT 0 NOT NULL,
	"issues_dispatched" integer DEFAULT 0 NOT NULL,
	"runs_requeued" integer DEFAULT 0 NOT NULL,
	"skipped_budget" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX "scheduler_ticks_ticked_at_idx" ON "scheduler_ticks" USING btree ("ticked_at");
