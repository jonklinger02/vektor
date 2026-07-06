import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { authUsers } from "./auth.js";

/**
 * Refinery sessions — user-private, notepad-like chat threads that refine an
 * idea into a task/goal/project. Company-agnostic until finalized.
 */
export const refinerySessions = pgTable(
  "refinery_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    title: text("title").notNull().default("New session"),
    status: text("status").notNull().default("active"), // active | finalized | archived
    model: text("model"),
    finalizedKind: text("finalized_kind"), // task | goal | project
    finalizedEntityId: uuid("finalized_entity_id"),
    finalizedCompanyId: uuid("finalized_company_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    ownerIdx: index("refinery_sessions_owner_idx").on(table.ownerUserId, table.updatedAt),
  }),
);
