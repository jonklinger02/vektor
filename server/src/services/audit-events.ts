import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { auditEvents } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

/**
 * SOC2-style immutable audit trail (see packages/db/src/schema/audit_events.ts).
 * This module is the only writer, and it only ever INSERTs — there is
 * deliberately no update or delete helper here, and none may be added.
 */

export type AuditActorType = "user" | "agent" | "system";

export interface AuditEventInput {
  /** null / omitted = instance-scoped event (e.g. routing governance). */
  companyId?: string | null;
  actorUserId?: string | null;
  actorType: AuditActorType;
  /** Dot-namespaced, e.g. "company.role_changed", "routing.version_promoted". */
  action: string;
  subjectType?: string | null;
  subjectId?: string | null;
  details?: Record<string, unknown> | null;
}

/**
 * Fire-and-forget append to the audit trail. Auditing must never break the
 * privileged mutation it describes, so every failure path (sync or async) is
 * swallowed and logged as a warning instead of thrown.
 */
export function emitAuditEvent(db: Db, input: AuditEventInput): void {
  try {
    void Promise.resolve(
      db.insert(auditEvents).values({
        companyId: input.companyId ?? null,
        actorUserId: input.actorUserId ?? null,
        actorType: input.actorType,
        action: input.action,
        subjectType: input.subjectType ?? null,
        subjectId: input.subjectId ?? null,
        details: input.details ?? null,
      }),
    ).catch((err) => {
      logger.warn({ err, action: input.action }, "audit event emission failed");
    });
  } catch (err) {
    logger.warn({ err, action: input.action }, "audit event emission failed");
  }
}

const DEFAULT_LIST_LIMIT = 50;
export const MAX_AUDIT_EVENTS_LIMIT = 200;

export interface ListAuditEventsOptions {
  companyId?: string;
  action?: string;
  limit?: number;
}

function clampLimit(limit: number | undefined): number {
  if (limit == null || !Number.isFinite(limit) || limit <= 0) return DEFAULT_LIST_LIMIT;
  return Math.min(Math.floor(limit), MAX_AUDIT_EVENTS_LIMIT);
}

/** Newest-first read of the audit trail, optionally filtered. */
export async function listAuditEvents(db: Db, options: ListAuditEventsOptions = {}) {
  const conditions = [];
  if (options.companyId) conditions.push(eq(auditEvents.companyId, options.companyId));
  if (options.action) conditions.push(eq(auditEvents.action, options.action));

  return db
    .select()
    .from(auditEvents)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(auditEvents.createdAt))
    .limit(clampLimit(options.limit));
}
