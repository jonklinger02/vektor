import { boolean, index, integer, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Append-only telemetry: one row per heartbeat-scheduler tick (the programmatic
 * check-for-tasks pass in server/src/index.ts). The tick itself is free — pure
 * DB reconciliation, no model tokens; work found during a tick is dispatched
 * through the budget hard-stop, and blocked dispatches surface here as
 * skippedBudget. Ported from the Vektor platform's HeartbeatTick scheme: the
 * row is the audit trail for the free-tick / paid-dispatch economic split, and
 * intervalMs recorded at tick time proves cadence reconfiguration took effect.
 */
export const schedulerTicks = pgTable(
  "scheduler_ticks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tickedAt: timestamp("ticked_at", { withTimezone: true }).notNull().defaultNow(),
    intervalMs: integer("interval_ms").notNull(),
    durationMs: integer("duration_ms").notNull(),
    /** True when this tick started later than 2x the configured cadence. */
    lapsed: boolean("lapsed").notNull().default(false),
    timersEnqueued: integer("timers_enqueued").notNull().default(0),
    routinesTriggered: integer("routines_triggered").notNull().default(0),
    retriesPromoted: integer("retries_promoted").notNull().default(0),
    issuesDispatched: integer("issues_dispatched").notNull().default(0),
    runsRequeued: integer("runs_requeued").notNull().default(0),
    /** Dispatches refused by the budget hard-stop during this tick's window. */
    skippedBudget: integer("skipped_budget").notNull().default(0),
    /** Dispatches deferred by per-company heartbeat allocation (cadence/concurrency). */
    skippedAllocation: integer("skipped_allocation").notNull().default(0),
  },
  (table) => ({
    tickedAtIdx: index("scheduler_ticks_ticked_at_idx").on(table.tickedAt),
  }),
);
