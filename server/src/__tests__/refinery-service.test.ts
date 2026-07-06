import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, refineryMessages, refinerySessions, authUsers } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { refineryService } from "../services/refinery.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres refinery service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("refineryService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-refinery-service-");
    db = createDb(tempDb.connectionString);
    const now = new Date();
    await db.insert(authUsers).values([
      { id: "user-1", name: "User One", email: "user-1@example.com", emailVerified: true, createdAt: now, updatedAt: now },
      { id: "user-2", name: "User Two", email: "user-2@example.com", emailVerified: true, createdAt: now, updatedAt: now },
    ]);
  }, 20_000);

  afterEach(async () => {
    await db.delete(refineryMessages);
    await db.delete(refinerySessions);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("creates, lists (newest first), and archives sessions scoped to owner", async () => {
    const svc = refineryService(db);
    const a = await svc.createSession("user-1");
    const b = await svc.createSession("user-1", { title: "Roof leads" });
    await svc.createSession("user-2");
    const mine = await svc.listSessions("user-1");
    expect(mine.map((s) => s.id)).toEqual([b.id, a.id]);
    const archived = await svc.updateSession(a.id, { status: "archived" });
    expect(archived?.status).toBe("archived");
  });

  it("auto-titles from the first user message and bumps updatedAt", async () => {
    const svc = refineryService(db);
    const s = await svc.createSession("user-1");
    await svc.addMessage(s.id, { role: "user", body: "We need a better CSV import for roofing leads because the current one drops rows" });
    const after = await svc.getSession(s.id);
    expect(after?.title).toBe("We need a better CSV import for roofing leads because the c…");
    expect(after!.updatedAt.getTime()).toBeGreaterThanOrEqual(s.updatedAt.getTime());
  });

  it("buildHistory omits context-excluded messages but transcript keeps them", async () => {
    const svc = refineryService(db);
    const s = await svc.createSession("user-1");
    await svc.addMessage(s.id, { role: "user", body: "keep me" });
    const wrong = await svc.addMessage(s.id, { role: "assistant", body: "totally wrong tangent" });
    await svc.addMessage(s.id, { role: "user", body: "also keep" });
    await svc.setMessageContextExcluded(wrong.id, true);
    const history = await svc.buildHistory(s.id);
    expect(history.map((m) => m.body)).toEqual(["keep me", "also keep"]);
    const transcript = await svc.listMessages(s.id);
    expect(transcript).toHaveLength(3);
    expect(transcript[1]?.contextExcluded).toBe(true);
    expect(transcript[1]?.body).toBe("totally wrong tangent");
  });
});
