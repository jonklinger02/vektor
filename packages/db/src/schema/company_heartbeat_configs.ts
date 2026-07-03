import { boolean, integer, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * Per-company heartbeat allocation (ported from the Vektor platform's
 * HeartbeatConfig scheme). The allocation is a trust-bounded budget split
 * between "processors" (dispatch throughput: max concurrent runs + minimum
 * interval between dispatch admissions) and "memory" (model-tier ceiling fed
 * into the smart-router's cost cap). No row (or enabled=false) means no
 * gating — existing companies keep today's unbounded behavior until they
 * opt in. Derivations live in server/src/services/company-heartbeat-policy.ts.
 */
export const companyHeartbeatConfigs = pgTable("company_heartbeat_configs", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id).unique(),
  processors: integer("processors").notNull().default(1),
  memory: integer("memory").notNull().default(1),
  trust: integer("trust").notNull().default(2),
  enabled: boolean("enabled").notNull().default(true),
  /** Last admitted dispatch (cadence enforcement anchor). */
  lastDispatchAt: timestamp("last_dispatch_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
