import { pgTable, uuid, text, timestamp, boolean, index } from "drizzle-orm/pg-core";
import { refinerySessions } from "./refinery_sessions.js";

/**
 * Refinery messages — immutable transcript rows. `contextExcluded` is the
 * ONLY mutable field: it removes a message from future model context without
 * touching the durable record.
 */
export const refineryMessages = pgTable(
  "refinery_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => refinerySessions.id, { onDelete: "cascade" }),
    role: text("role").notNull(), // user | assistant
    body: text("body").notNull(),
    model: text("model"),
    contextExcluded: boolean("context_excluded").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sessionIdx: index("refinery_messages_session_idx").on(table.sessionId, table.createdAt),
  }),
);
