import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * Versioned per-task-class routing tables (ported from the Vektor platform's
 * RoutingConfigVersion scheme). Each row is an immutable snapshot of the
 * model table for one task class: an ordered array of specs
 * `{ model: string, cost: 1..4, capability: 1..4 }`. Lifecycle:
 * draft → canary(percent) → active → superseded, with frozen as an emergency
 * pin and rejected for discarded drafts. At most one active and one canary
 * per task class (partial unique indexes). The smart-router consults
 * active/canary tables first and falls back to the built-in model catalog
 * when a class has no active version.
 */
export const routingConfigVersions = pgTable(
  "routing_config_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskClass: text("task_class").notNull(),
    version: integer("version").notNull(),
    /** draft | canary | active | frozen | superseded | rejected */
    status: text("status").notNull().default("draft"),
    /** Ordered array of { model, cost, capability }. */
    modelSpecs: jsonb("model_specs").notNull(),
    canaryPercent: integer("canary_percent"),
    previousVersionId: uuid("previous_version_id"),
    createdByUserId: text("created_by_user_id"),
    promotedAt: timestamp("promoted_at", { withTimezone: true }),
    frozenAt: timestamp("frozen_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    classVersionIdx: uniqueIndex("routing_config_versions_class_version_idx").on(
      table.taskClass,
      table.version,
    ),
    classStatusIdx: index("routing_config_versions_class_status_idx").on(
      table.taskClass,
      table.status,
    ),
  }),
);

/**
 * One row per smart-router decision (ported from RoutingDecisionAuditLog):
 * the replayable audit trail for "why did this task run on that model".
 */
export const routingDecisionAudit = pgTable(
  "routing_decision_audit",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(),
    heartbeatRunId: uuid("heartbeat_run_id"),
    issueId: uuid("issue_id"),
    adapterType: text("adapter_type").notNull(),
    taskClass: text("task_class").notNull(),
    /** Null when the decision came from the built-in catalog fallback. */
    routingConfigVersionId: uuid("routing_config_version_id"),
    canaryBucket: boolean("canary_bucket").notNull().default(false),
    model: text("model").notNull(),
    /** True when an allocation tier ceiling degraded the choice. */
    capped: boolean("capped").notNull().default(false),
    reasoning: text("reasoning").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("routing_decision_audit_company_created_idx").on(
      table.companyId,
      table.createdAt,
    ),
  }),
);
