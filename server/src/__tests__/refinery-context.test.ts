import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, goals, projects } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { buildRefineryContextPack } from "../services/refinery-context.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres refinery context tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("buildRefineryContextPack", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-refinery-context-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(goals);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("summarizes companies, agents, projects, goals as markdown", async () => {
    const [company] = await db.insert(companies).values({ name: "KITSCo" }).returning();
    const companyId = company!.id;

    await db.insert(agents).values({
      companyId,
      name: "Lead Agent",
      role: "general",
    });
    await db.insert(projects).values({
      companyId,
      name: "CRM",
      status: "in_progress",
    });
    await db.insert(goals).values({
      companyId,
      title: "Q3 revenue",
      level: "company",
      status: "active",
    });

    const pack = await buildRefineryContextPack(db, [companyId]);
    expect(pack).toContain("## Company: KITSCo");
    expect(pack).toContain("Lead Agent");
    expect(pack).toContain("CRM");
    expect(pack).toContain("Q3 revenue");
  });

  it("returns empty string for no companies and never throws on a bad id", async () => {
    expect(await buildRefineryContextPack(db, [])).toBe("");
    expect(await buildRefineryContextPack(db, ["00000000-0000-0000-0000-000000000000"])).toBe("");
  });
});
