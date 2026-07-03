import { createHash } from "node:crypto";
import { and, desc, eq, inArray, max } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { routingConfigVersions, routingDecisionAudit } from "@paperclipai/db";
import { ALL_TASK_CLASSES, type TaskClass } from "./smart-router/types.js";

/**
 * Routing governance (ported from the Vektor platform's routing-config
 * scheme): versioned per-task-class model tables with a
 * draft → canary(percent) → active → superseded lifecycle, frozen as an
 * emergency pin, deterministic canary bucketing, and an append-only audit
 * row per routing decision. The smart-router consults the resolved table
 * first and falls back to its built-in model catalog when a class has no
 * active version — governance is opt-in per class, never a boot dependency.
 */

export type ModelSpec = { model: string; cost: number; capability: number };

export type RoutingVersionStatus =
  | "draft"
  | "canary"
  | "active"
  | "frozen"
  | "superseded"
  | "rejected";

export type ResolvedRoutingTable = {
  versionId: string;
  version: number;
  status: RoutingVersionStatus;
  specs: ModelSpec[];
  /** Set when a canary version exists for the class. */
  canary: { versionId: string; version: number; percent: number; specs: ModelSpec[] } | null;
};

const CACHE_TTL_MS = 15_000;

type CacheEntry = { expiresAt: number; table: ResolvedRoutingTable | null };
declare global {
  // eslint-disable-next-line no-var
  var __paperclipRoutingTableCache: Map<string, CacheEntry> | undefined;
}
const tableCache = (globalThis.__paperclipRoutingTableCache ??= new Map<string, CacheEntry>());

export function invalidateRoutingCache(taskClass?: string): void {
  if (taskClass) tableCache.delete(taskClass);
  else tableCache.clear();
}

function parseSpecs(raw: unknown): ModelSpec[] {
  if (!Array.isArray(raw)) return [];
  const specs: ModelSpec[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const { model, cost, capability } = entry as Record<string, unknown>;
    if (typeof model !== "string" || model.trim() === "") continue;
    if (typeof cost !== "number" || typeof capability !== "number") continue;
    specs.push({ model, cost, capability });
  }
  return specs;
}

export function validateSpecs(raw: unknown): ModelSpec[] {
  const specs = parseSpecs(raw);
  if (specs.length === 0) {
    throw new Error("modelSpecs must be a non-empty array of { model, cost: 1..4, capability: 1..4 }");
  }
  for (const spec of specs) {
    if (spec.cost < 1 || spec.cost > 4 || spec.capability < 1 || spec.capability > 4) {
      throw new Error(`modelSpecs entry ${spec.model}: cost/capability must be within 1..4`);
    }
  }
  return specs;
}

export function assertTaskClass(value: string): TaskClass {
  if (!ALL_TASK_CLASSES.includes(value as TaskClass)) {
    throw new Error(`Unknown task class "${value}" (valid: ${ALL_TASK_CLASSES.join(", ")})`);
  }
  return value as TaskClass;
}

export function configHash(specs: ModelSpec[]): string {
  return createHash("sha256").update(JSON.stringify(specs)).digest("hex").slice(0, 16);
}

/**
 * Deterministic canary bucketing (ported from canary-bucketing.ts): a pure
 * hash of (companyId, issueId) mapped onto 0..99 — stable per issue, so an
 * issue never flip-flops between tables across retries.
 */
export function canaryBucketValue(companyId: string, issueId: string): number {
  const digest = createHash("sha256").update(`${companyId}:${issueId}`).digest();
  return ((digest[0]! << 8) | digest[1]!) % 100;
}

export function isCanaryBucket(companyId: string, issueId: string, percent: number): boolean {
  if (percent <= 0) return false;
  if (percent >= 100) return true;
  return canaryBucketValue(companyId, issueId) < percent;
}

/** Resolve the effective table for a class (active/frozen + optional canary). Cached. */
export async function getRoutingTable(
  db: Db,
  taskClass: string,
): Promise<ResolvedRoutingTable | null> {
  const cached = tableCache.get(taskClass);
  if (cached && cached.expiresAt > Date.now()) return cached.table;
  let table: ResolvedRoutingTable | null = null;
  try {
    const rows = await db
      .select()
      .from(routingConfigVersions)
      .where(
        and(
          eq(routingConfigVersions.taskClass, taskClass),
          inArray(routingConfigVersions.status, ["active", "frozen", "canary"]),
        ),
      );
    const activeRow = rows.find((r) => r.status === "active" || r.status === "frozen") ?? null;
    const canaryRow = rows.find((r) => r.status === "canary") ?? null;
    if (activeRow) {
      table = {
        versionId: activeRow.id,
        version: activeRow.version,
        status: activeRow.status as RoutingVersionStatus,
        specs: parseSpecs(activeRow.modelSpecs),
        canary: canaryRow
          ? {
              versionId: canaryRow.id,
              version: canaryRow.version,
              percent: canaryRow.canaryPercent ?? 0,
              specs: parseSpecs(canaryRow.modelSpecs),
            }
          : null,
      };
    }
  } catch {
    table = null; // fail-open to the built-in catalog
  }
  tableCache.set(taskClass, { expiresAt: Date.now() + CACHE_TTL_MS, table });
  return table;
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

export async function listVersions(db: Db, taskClass?: string) {
  const base = db.select().from(routingConfigVersions);
  const rows = taskClass
    ? await base.where(eq(routingConfigVersions.taskClass, taskClass)).orderBy(desc(routingConfigVersions.version))
    : await base.orderBy(routingConfigVersions.taskClass, desc(routingConfigVersions.version));
  return rows;
}

export async function propose(
  db: Db,
  input: { taskClass: string; modelSpecs: unknown; createdByUserId?: string | null },
) {
  const taskClass = assertTaskClass(input.taskClass);
  const specs = validateSpecs(input.modelSpecs);
  const latest = await db
    .select({ value: max(routingConfigVersions.version) })
    .from(routingConfigVersions)
    .where(eq(routingConfigVersions.taskClass, taskClass))
    .then((rows) => rows[0]?.value ?? 0);
  const inserted = await db
    .insert(routingConfigVersions)
    .values({
      taskClass,
      version: (latest ?? 0) + 1,
      status: "draft",
      modelSpecs: specs,
      createdByUserId: input.createdByUserId ?? null,
    })
    .returning();
  return inserted[0]!;
}

/** CAS transition helper: only moves the row if it is still in `from`. */
async function transition(
  db: Db,
  versionId: string,
  from: RoutingVersionStatus[],
  to: RoutingVersionStatus,
  patch: Partial<typeof routingConfigVersions.$inferInsert> = {},
) {
  const updated = await db
    .update(routingConfigVersions)
    .set({ status: to, updatedAt: new Date(), ...patch })
    .where(
      and(
        eq(routingConfigVersions.id, versionId),
        inArray(routingConfigVersions.status, from),
      ),
    )
    .returning();
  if (updated.length === 0) {
    throw new Error(`Version ${versionId} is not in state ${from.join("/")} (concurrent change?)`);
  }
  return updated[0]!;
}

export async function promoteToCanary(db: Db, versionId: string, percent: number) {
  if (!Number.isInteger(percent) || percent < 1 || percent > 99) {
    throw new Error("canary percent must be an integer 1..99");
  }
  const row = await db
    .select()
    .from(routingConfigVersions)
    .where(eq(routingConfigVersions.id, versionId))
    .then((rows) => rows[0] ?? null);
  if (!row) throw new Error("Version not found");
  // Demote any existing canary for the class first (one canary per class).
  await db
    .update(routingConfigVersions)
    .set({ status: "superseded", updatedAt: new Date() })
    .where(
      and(
        eq(routingConfigVersions.taskClass, row.taskClass),
        eq(routingConfigVersions.status, "canary"),
      ),
    );
  const updated = await transition(db, versionId, ["draft"], "canary", { canaryPercent: percent });
  invalidateRoutingCache(row.taskClass);
  return updated;
}

export async function promoteToActive(db: Db, versionId: string) {
  const row = await db
    .select()
    .from(routingConfigVersions)
    .where(eq(routingConfigVersions.id, versionId))
    .then((rows) => rows[0] ?? null);
  if (!row) throw new Error("Version not found");
  const currentActive = await db
    .select()
    .from(routingConfigVersions)
    .where(
      and(
        eq(routingConfigVersions.taskClass, row.taskClass),
        inArray(routingConfigVersions.status, ["active", "frozen"]),
      ),
    )
    .then((rows) => rows[0] ?? null);
  if (currentActive && currentActive.status === "frozen") {
    throw new Error(`Task class ${row.taskClass} is frozen; unfreeze or rollback before promoting`);
  }
  if (currentActive) {
    await transition(db, currentActive.id, ["active"], "superseded");
  }
  const updated = await transition(db, versionId, ["draft", "canary"], "active", {
    promotedAt: new Date(),
    previousVersionId: currentActive?.id ?? null,
    canaryPercent: null,
  });
  invalidateRoutingCache(row.taskClass);
  return updated;
}

export async function freeze(db: Db, taskClass: string) {
  const active = await db
    .select()
    .from(routingConfigVersions)
    .where(
      and(eq(routingConfigVersions.taskClass, taskClass), eq(routingConfigVersions.status, "active")),
    )
    .then((rows) => rows[0] ?? null);
  if (!active) throw new Error(`No active version for ${taskClass}`);
  const updated = await transition(db, active.id, ["active"], "frozen", { frozenAt: new Date() });
  invalidateRoutingCache(taskClass);
  return updated;
}

export async function unfreeze(db: Db, taskClass: string) {
  const frozen = await db
    .select()
    .from(routingConfigVersions)
    .where(
      and(eq(routingConfigVersions.taskClass, taskClass), eq(routingConfigVersions.status, "frozen")),
    )
    .then((rows) => rows[0] ?? null);
  if (!frozen) throw new Error(`No frozen version for ${taskClass}`);
  const updated = await transition(db, frozen.id, ["frozen"], "active", { frozenAt: null });
  invalidateRoutingCache(taskClass);
  return updated;
}

export async function rollback(db: Db, taskClass: string) {
  const current = await db
    .select()
    .from(routingConfigVersions)
    .where(
      and(
        eq(routingConfigVersions.taskClass, taskClass),
        inArray(routingConfigVersions.status, ["active", "frozen"]),
      ),
    )
    .then((rows) => rows[0] ?? null);
  if (!current) throw new Error(`No active version for ${taskClass}`);
  if (!current.previousVersionId) throw new Error(`Version ${current.version} has no rollback target`);
  await transition(db, current.id, ["active", "frozen"], "superseded");
  const restored = await transition(db, current.previousVersionId, ["superseded"], "active", {
    promotedAt: new Date(),
  });
  invalidateRoutingCache(taskClass);
  return restored;
}

// ── Audit ────────────────────────────────────────────────────────────────────

export type RoutingAuditInput = {
  companyId: string;
  heartbeatRunId?: string | null;
  issueId?: string | null;
  adapterType: string;
  taskClass: string;
  routingConfigVersionId?: string | null;
  canaryBucket: boolean;
  model: string;
  capped: boolean;
  reasoning: string;
};

/** Fire-and-forget audit write — never blocks or fails a dispatch. */
export function emitRoutingDecisionAudit(db: Db, input: RoutingAuditInput): void {
  void db
    .insert(routingDecisionAudit)
    .values({
      companyId: input.companyId,
      heartbeatRunId: input.heartbeatRunId ?? null,
      issueId: input.issueId ?? null,
      adapterType: input.adapterType,
      taskClass: input.taskClass,
      routingConfigVersionId: input.routingConfigVersionId ?? null,
      canaryBucket: input.canaryBucket,
      model: input.model,
      capped: input.capped,
      reasoning: input.reasoning,
    })
    .catch(() => {});
}

export async function listAuditEntries(
  db: Db,
  companyId: string,
  limit = 50,
) {
  return db
    .select()
    .from(routingDecisionAudit)
    .where(eq(routingDecisionAudit.companyId, companyId))
    .orderBy(desc(routingDecisionAudit.createdAt))
    .limit(Math.min(Math.max(limit, 1), 200));
}
