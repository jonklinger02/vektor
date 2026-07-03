import { and, count, eq, gte } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, schedulerTicks } from "@paperclipai/db";

/**
 * Scheduler tick telemetry — the audit trail for the free-tick / paid-dispatch
 * split (ported from the Vektor platform's HeartbeatTick scheme). One append-only
 * row per heartbeat-scheduler pass: what the free scan found and drove forward,
 * and how many dispatches the budget hard-stop refused in the tick's window.
 * Recording is strictly best-effort — telemetry must never break the scheduler.
 */

export type SchedulerTickStats = {
  tickStartedAt: Date;
  intervalMs: number;
  durationMs: number;
  lapsed: boolean;
  timersEnqueued: number;
  routinesTriggered: number;
  retriesPromoted: number;
  issuesDispatched: number;
  runsRequeued: number;
  skippedBudget: number;
  skippedAllocation: number;
};

/** Skipped wakeup rows with `reason` written since `since` (see
 * heartbeat.ts writeSkippedRequest — "budget.blocked", "allocation.deferred"). */
async function countSkipsSince(db: Db, reason: string, since: Date): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.status, "skipped"),
        eq(agentWakeupRequests.reason, reason),
        gte(agentWakeupRequests.createdAt, since),
      ),
    );
  return rows[0]?.value ?? 0;
}

export async function countBudgetSkipsSince(db: Db, since: Date): Promise<number> {
  return countSkipsSince(db, "budget.blocked", since);
}

export async function countAllocationSkipsSince(db: Db, since: Date): Promise<number> {
  return countSkipsSince(db, "allocation.deferred", since);
}

export async function recordSchedulerTick(db: Db, stats: SchedulerTickStats): Promise<void> {
  await db.insert(schedulerTicks).values({
    tickedAt: stats.tickStartedAt,
    intervalMs: stats.intervalMs,
    durationMs: stats.durationMs,
    lapsed: stats.lapsed,
    timersEnqueued: stats.timersEnqueued,
    routinesTriggered: stats.routinesTriggered,
    retriesPromoted: stats.retriesPromoted,
    issuesDispatched: stats.issuesDispatched,
    runsRequeued: stats.runsRequeued,
    skippedBudget: stats.skippedBudget,
    skippedAllocation: stats.skippedAllocation,
  });
}
