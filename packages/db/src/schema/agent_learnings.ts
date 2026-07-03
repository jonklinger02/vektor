import { pgTable, uuid, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

// Durable agent self-learnings captured from completed heartbeat runs
// (hermes-style capture/recall loop). agentId is intentionally a plain uuid
// with NO foreign key: deleting an agent must not cascade-delete (or block on)
// its accumulated learnings. sourceRunId is likewise a soft reference.
export const agentLearnings = pgTable(
  "agent_learnings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull(),
    kind: text("kind").notNull(), // 'correction' | 'preference' | 'technique' | 'fact'
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),
    sourceRunId: uuid("source_run_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentContentHashUq: uniqueIndex("agent_learnings_agent_content_hash_uq").on(
      table.agentId,
      table.contentHash,
    ),
    companyAgentCreatedIdx: index("agent_learnings_company_agent_created_idx").on(
      table.companyId,
      table.agentId,
      table.createdAt,
    ),
  }),
);
