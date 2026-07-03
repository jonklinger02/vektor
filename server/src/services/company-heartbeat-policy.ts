import { and, count, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companyHeartbeatConfigs, heartbeatRuns } from "@paperclipai/db";

/**
 * Per-company heartbeat allocation (ported from the Vektor platform's
 * HeartbeatConfig / heartbeat-policy scheme).
 *
 * The allocation is a trust-bounded budget split between:
 *  - processors → dispatch throughput: max concurrent active runs, plus a
 *    minimum interval between admitted dispatches (1 processor = one dispatch
 *    per minute; each additional processor divides the interval, floor 2s).
 *  - memory → the model-tier COST ceiling the smart-router may select
 *    (0-1: cheapest lane only … 6+: everything).
 *
 * Invariant: processors + memory <= trust; trust is raised over time (future
 * milestone hook). No config row, or enabled=false → NO gating: existing
 * companies keep today's unbounded behavior until they opt in. Every check is
 * fail-open — an allocation lookup error must never block dispatch.
 */

export type CompanyHeartbeatPolicy = {
  processors: number;
  memory: number;
  trust: number;
  /** Max concurrently active (queued/running) runs for the company. */
  maxConcurrentRuns: number;
  /** Minimum ms between admitted dispatches. */
  dispatchMinIntervalMs: number;
  /** Smart-router cost-rank ceiling (1 cheapest … 4 premium). */
  tierCostCeiling: number;
};

export type AllocationVerdict =
  | { admitted: true }
  | { admitted: false; reason: "cadence" | "concurrency"; detail: string };

const BASE_DISPATCH_INTERVAL_MS = 60_000;
const MIN_DISPATCH_INTERVAL_MS = 2_000;
const POLICY_CACHE_TTL_MS = 15_000;
/** heartbeat_runs statuses that count against the concurrency allocation. */
const ACTIVE_RUN_STATUSES = ["queued", "running"] as const;

export function isValidAllocation(processors: number, memory: number, trust: number): boolean {
  return (
    Number.isInteger(processors) &&
    Number.isInteger(memory) &&
    processors >= 0 &&
    memory >= 0 &&
    processors + memory <= trust
  );
}

export function dispatchMinIntervalMs(processors: number): number {
  if (processors <= 0) return Number.POSITIVE_INFINITY; // 0 processors = dispatch paused
  return Math.max(MIN_DISPATCH_INTERVAL_MS, Math.round(BASE_DISPATCH_INTERVAL_MS / processors));
}

export function tierCostCeiling(memory: number): number {
  if (memory >= 6) return 4;
  if (memory >= 4) return 3;
  if (memory >= 2) return 2;
  return 1;
}

export function derivePolicy(config: {
  processors: number;
  memory: number;
  trust: number;
}): CompanyHeartbeatPolicy {
  return {
    processors: config.processors,
    memory: config.memory,
    trust: config.trust,
    maxConcurrentRuns: Math.max(0, config.processors),
    dispatchMinIntervalMs: dispatchMinIntervalMs(config.processors),
    tierCostCeiling: tierCostCeiling(config.memory),
  };
}

type CacheEntry = {
  expiresAt: number;
  row: typeof companyHeartbeatConfigs.$inferSelect | null;
};

declare global {
  // eslint-disable-next-line no-var
  var __paperclipHeartbeatPolicyCache: Map<string, CacheEntry> | undefined;
}
const cache = (globalThis.__paperclipHeartbeatPolicyCache ??= new Map<string, CacheEntry>());

async function loadConfigRow(db: Db, companyId: string) {
  const cached = cache.get(companyId);
  if (cached && cached.expiresAt > Date.now()) return cached.row;
  const row = await db
    .select()
    .from(companyHeartbeatConfigs)
    .where(eq(companyHeartbeatConfigs.companyId, companyId))
    .then((rows) => rows[0] ?? null);
  cache.set(companyId, { expiresAt: Date.now() + POLICY_CACHE_TTL_MS, row });
  return row;
}

export function invalidatePolicyCache(companyId?: string): void {
  if (companyId) cache.delete(companyId);
  else cache.clear();
}

/** The company's derived policy, or null when unconfigured/disabled (no gating). */
export async function getCompanyHeartbeatPolicy(
  db: Db,
  companyId: string,
): Promise<CompanyHeartbeatPolicy | null> {
  try {
    const row = await loadConfigRow(db, companyId);
    if (!row || !row.enabled) return null;
    return derivePolicy(row);
  } catch {
    return null; // fail-open
  }
}

/**
 * Allocation admission for one dispatch attempt at the single invocation
 * funnel (heartbeat.ts). Cadence is anchored on last_dispatch_at; concurrency
 * on the live count of active runs. Fail-open on any error.
 */
export async function admitDispatch(db: Db, companyId: string): Promise<AllocationVerdict> {
  try {
    const row = await loadConfigRow(db, companyId);
    if (!row || !row.enabled) return { admitted: true };
    const policy = derivePolicy(row);

    if (policy.processors <= 0) {
      return {
        admitted: false,
        reason: "cadence",
        detail: "Heartbeat allocation has 0 processors — dispatch is paused for this company.",
      };
    }

    const sinceLastMs = row.lastDispatchAt
      ? Date.now() - row.lastDispatchAt.getTime()
      : Number.POSITIVE_INFINITY;
    if (sinceLastMs < policy.dispatchMinIntervalMs) {
      return {
        admitted: false,
        reason: "cadence",
        detail: `Dispatch cadence is one per ${Math.round(policy.dispatchMinIntervalMs / 1000)}s at ${policy.processors} processor(s); next slot in ${Math.ceil((policy.dispatchMinIntervalMs - sinceLastMs) / 1000)}s.`,
      };
    }

    const active = await db
      .select({ value: count() })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          inArray(heartbeatRuns.status, [...ACTIVE_RUN_STATUSES]),
        ),
      )
      .then((rows) => rows[0]?.value ?? 0);
    if (active >= policy.maxConcurrentRuns) {
      return {
        admitted: false,
        reason: "concurrency",
        detail: `${active} run(s) already active; allocation permits ${policy.maxConcurrentRuns} concurrent run(s) at ${policy.processors} processor(s).`,
      };
    }

    return { admitted: true };
  } catch {
    return { admitted: true }; // fail-open
  }
}

/** Record an admitted dispatch (cadence anchor). Best-effort. */
export async function recordDispatchAdmission(db: Db, companyId: string): Promise<void> {
  try {
    await db
      .update(companyHeartbeatConfigs)
      .set({ lastDispatchAt: new Date(), updatedAt: new Date() })
      .where(eq(companyHeartbeatConfigs.companyId, companyId));
    invalidatePolicyCache(companyId);
  } catch {
    // best-effort
  }
}

/** Upsert the allocation (validated against the trust ceiling). */
export async function reallocate(
  db: Db,
  companyId: string,
  allocation: { processors: number; memory: number },
): Promise<CompanyHeartbeatPolicy> {
  const existing = await db
    .select()
    .from(companyHeartbeatConfigs)
    .where(eq(companyHeartbeatConfigs.companyId, companyId))
    .then((rows) => rows[0] ?? null);
  const trust = existing?.trust ?? 2;
  if (!isValidAllocation(allocation.processors, allocation.memory, trust)) {
    throw new Error(
      `Invalid allocation: processors + memory must be integers >= 0 and <= trust (${trust})`,
    );
  }
  if (existing) {
    await db
      .update(companyHeartbeatConfigs)
      .set({ processors: allocation.processors, memory: allocation.memory, updatedAt: new Date() })
      .where(eq(companyHeartbeatConfigs.companyId, companyId));
  } else {
    await db.insert(companyHeartbeatConfigs).values({
      companyId,
      processors: allocation.processors,
      memory: allocation.memory,
      trust,
    });
  }
  invalidatePolicyCache(companyId);
  return derivePolicy({ processors: allocation.processors, memory: allocation.memory, trust });
}
