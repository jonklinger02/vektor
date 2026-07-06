import { and, asc, desc, eq } from "drizzle-orm";
import { refineryMessages, refinerySessions, type Db } from "@paperclipai/db";

const AUTO_TITLE_MAX = 60;
const DEFAULT_TITLE = "New session";

function autoTitle(body: string): string {
  const oneLine = body.replace(/\s+/g, " ").trim();
  return oneLine.length <= AUTO_TITLE_MAX ? oneLine : `${oneLine.slice(0, AUTO_TITLE_MAX - 1).trimEnd()}…`;
}

export function refineryService(db: Db) {
  return {
    listSessions: (ownerUserId: string) =>
      db.select().from(refinerySessions)
        .where(eq(refinerySessions.ownerUserId, ownerUserId))
        .orderBy(desc(refinerySessions.updatedAt)),

    createSession: (ownerUserId: string, data?: { title?: string }) =>
      db.insert(refinerySessions)
        .values({ ownerUserId, ...(data?.title ? { title: data.title } : {}) })
        .returning().then((rows) => rows[0]!),

    getSession: (id: string) =>
      db.select().from(refinerySessions).where(eq(refinerySessions.id, id))
        .then((rows) => rows[0] ?? null),

    updateSession: (
      id: string,
      data: Partial<{ title: string; status: string; model: string | null;
        finalizedKind: string; finalizedEntityId: string; finalizedCompanyId: string }>,
    ) =>
      db.update(refinerySessions).set({ ...data, updatedAt: new Date() })
        .where(eq(refinerySessions.id, id)).returning().then((rows) => rows[0] ?? null),

    listMessages: (sessionId: string) =>
      db.select().from(refineryMessages)
        .where(eq(refineryMessages.sessionId, sessionId))
        .orderBy(asc(refineryMessages.createdAt)),

    getMessage: (messageId: string) =>
      db.select().from(refineryMessages).where(eq(refineryMessages.id, messageId))
        .then((rows) => rows[0] ?? null),

    addMessage: async (
      sessionId: string,
      data: { role: "user" | "assistant"; body: string; model?: string | null },
    ) => {
      const inserted = await db.insert(refineryMessages)
        .values({ sessionId, role: data.role, body: data.body, model: data.model ?? null })
        .returning().then((rows) => rows[0]!);
      const session = await db.select().from(refinerySessions)
        .where(eq(refinerySessions.id, sessionId)).then((rows) => rows[0]);
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (data.role === "user" && session && session.title === DEFAULT_TITLE) {
        patch.title = autoTitle(data.body);
      }
      if (data.model) patch.model = data.model;
      await db.update(refinerySessions).set(patch).where(eq(refinerySessions.id, sessionId));
      return inserted;
    },

    setMessageContextExcluded: (messageId: string, excluded: boolean) =>
      db.update(refineryMessages).set({ contextExcluded: excluded })
        .where(eq(refineryMessages.id, messageId)).returning()
        .then((rows) => rows[0] ?? null),

    /** Prompt context: included messages only, oldest first. */
    buildHistory: (sessionId: string) =>
      db.select({ role: refineryMessages.role, body: refineryMessages.body })
        .from(refineryMessages)
        .where(and(
          eq(refineryMessages.sessionId, sessionId),
          eq(refineryMessages.contextExcluded, false),
        ))
        .orderBy(asc(refineryMessages.createdAt)) as Promise<Array<{ role: "user" | "assistant"; body: string }>>,
  };
}
