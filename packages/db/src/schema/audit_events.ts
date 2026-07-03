import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";

/**
 * Immutable, append-only audit trail for privileged mutations (SOC2
 * groundwork). Rows are only ever inserted — no application code path may
 * UPDATE or DELETE them. `companyId` is nullable: null marks an
 * instance-scoped event (e.g. routing governance) rather than a
 * company-scoped one. Deliberately no FK to companies: audit history must
 * survive company deletion, and a restrictive FK would block it.
 */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id"),
    actorUserId: text("actor_user_id"),
    actorType: text("actor_type").notNull(),
    action: text("action").notNull(),
    subjectType: text("subject_type"),
    subjectId: text("subject_id"),
    details: jsonb("details").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("audit_events_company_created_idx").on(table.companyId, table.createdAt),
    actionCreatedIdx: index("audit_events_action_created_idx").on(table.action, table.createdAt),
  }),
);
