import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { agentLearnings, heartbeatRuns, issues } from "@paperclipai/db";

vi.mock("./llm-utility.js", () => ({
  completeText: vi.fn(),
}));

// The real logger creates its log directory at import time — keep the unit
// test hermetic (same seam as live-events-ws.test.ts).
vi.mock("../middleware/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { completeText } from "./llm-utility.js";
import {
  contentHash,
  parseLearnings,
  recallForAgent,
  reviewRunForLearning,
} from "./agent-learning.js";

const completeTextMock = vi.mocked(completeText);

type RunRow = {
  id: string;
  companyId: string;
  agentId: string;
  status: string;
  resultJson: Record<string, unknown> | null;
  contextSnapshot: Record<string, unknown> | null;
};

function runRow(overrides: Partial<RunRow> = {}): RunRow {
  return {
    id: randomUUID(),
    companyId: randomUUID(),
    agentId: randomUUID(),
    status: "succeeded",
    resultJson: { summary: "did the thing" },
    contextSnapshot: null,
    ...overrides,
  };
}

/**
 * The learning service takes its Db as an argument (same seam as
 * company-heartbeat-policy), so the test double is a vi.fn-backed fake Db
 * whose select().from(table)... chain resolves canned rows per table and
 * whose insert().values().onConflictDoNothing() records inserted rows.
 */
function fakeDb(opts: {
  runRow?: RunRow | null;
  issueRow?: { title: string; description: string | null } | null;
  learningRows?: Array<{ kind: string; content: string }>;
  failSelect?: boolean;
} = {}) {
  const inserted: Array<Record<string, unknown>[]> = [];
  const onConflictDoNothing = vi.fn(() => Promise.resolve([]));

  const db = {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => {
        const rowsFor = (): unknown[] => {
          if (opts.failSelect) throw new Error("db unavailable");
          if (table === heartbeatRuns) return opts.runRow ? [opts.runRow] : [];
          if (table === issues) return opts.issueRow ? [opts.issueRow] : [];
          if (table === agentLearnings) return opts.learningRows ?? [];
          return [];
        };
        const chain: Record<string, unknown> = {};
        chain.where = vi.fn(() => chain);
        chain.orderBy = vi.fn(() => chain);
        chain.limit = vi.fn(() => Promise.resolve(rowsFor()));
        chain.then = (
          onFulfilled?: (rows: unknown[]) => unknown,
          onRejected?: (err: unknown) => unknown,
        ) => Promise.resolve().then(rowsFor).then(onFulfilled, onRejected);
        return chain;
      }),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((rows: Record<string, unknown>[]) => {
        inserted.push(rows);
        return { onConflictDoNothing };
      }),
    })),
  };

  return { db: db as unknown as Db, inserted, onConflictDoNothing };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("parseLearnings", () => {
  it("parses a valid strict JSON array and normalizes kinds", () => {
    const parsed = parseLearnings(
      '[{"kind":"TECHNIQUE","content":"Run typecheck before finishing"},{"kind":"fact","content":"CI uses pnpm"}]',
    );
    expect(parsed).toEqual([
      { kind: "technique", content: "Run typecheck before finishing" },
      { kind: "fact", content: "CI uses pnpm" },
    ]);
  });

  it("extracts the first [...] block from surrounding prose", () => {
    const parsed = parseLearnings(
      'Here are the learnings:\n```json\n[{"kind":"preference","content":"User prefers tabs"}]\n```\nDone.',
    );
    expect(parsed).toEqual([{ kind: "preference", content: "User prefers tabs" }]);
  });

  it("drops entries with invalid kinds or empty content", () => {
    const parsed = parseLearnings(
      '[{"kind":"opinion","content":"nope"},{"kind":"correction","content":""},{"kind":"correction","content":"real one"},"garbage",null]',
    );
    expect(parsed).toEqual([{ kind: "correction", content: "real one" }]);
  });

  it("returns [] for malformed JSON", () => {
    expect(parseLearnings("not json at all")).toEqual([]);
    expect(parseLearnings('[{"kind": "fact", "content": ')).toEqual([]);
    expect(parseLearnings('{"kind":"fact","content":"an object, not an array"}')).toEqual([]);
  });
});

describe("reviewRunForLearning", () => {
  it("inserts parsed learnings with sha256 content hashes for a succeeded run", async () => {
    const run = runRow();
    const { db, inserted, onConflictDoNothing } = fakeDb({ runRow: run });
    completeTextMock.mockResolvedValue(
      '[{"kind":"technique","content":"Always run the linter"},{"kind":"fact","content":"Deploys go through CI"}]',
    );

    await reviewRunForLearning(db, run.id);

    expect(inserted).toHaveLength(1);
    const rows = inserted[0];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      companyId: run.companyId,
      agentId: run.agentId,
      kind: "technique",
      content: "Always run the linter",
      sourceRunId: run.id,
    });
    const expectedHash = createHash("sha256")
      .update("always run the linter")
      .digest("hex");
    expect(rows[0].contentHash).toBe(expectedHash);
    expect(onConflictDoNothing).toHaveBeenCalledTimes(1);
  });

  it("does not insert and does not throw on malformed JSON", async () => {
    const run = runRow();
    const { db, inserted } = fakeDb({ runRow: run });
    completeTextMock.mockResolvedValue("I could not produce JSON, sorry!");

    await expect(reviewRunForLearning(db, run.id)).resolves.toBeUndefined();
    expect(inserted).toHaveLength(0);
  });

  it("skips within-batch duplicates by contentHash", async () => {
    const run = runRow();
    const { db, inserted } = fakeDb({ runRow: run });
    completeTextMock.mockResolvedValue(
      '[{"kind":"fact","content":"CI uses pnpm"},{"kind":"technique","content":"CI   uses\\npnpm"},{"kind":"preference","content":"distinct"}]',
    );

    await reviewRunForLearning(db, run.id);

    expect(inserted).toHaveLength(1);
    const rows = inserted[0];
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.content)).toEqual(["CI uses pnpm", "distinct"]);
  });

  it("caps persisted learnings at 3 per review", async () => {
    const run = runRow();
    const { db, inserted } = fakeDb({ runRow: run });
    completeTextMock.mockResolvedValue(
      JSON.stringify(
        ["a", "b", "c", "d", "e"].map((content) => ({ kind: "fact", content })),
      ),
    );

    await reviewRunForLearning(db, run.id);

    expect(inserted[0]).toHaveLength(3);
  });

  it("no-ops on non-succeeded runs without calling the model", async () => {
    const run = runRow({ status: "failed" });
    const { db, inserted } = fakeDb({ runRow: run });

    await reviewRunForLearning(db, run.id);

    expect(completeTextMock).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(0);
  });

  it("no-ops when the run does not exist", async () => {
    const { db, inserted } = fakeDb({ runRow: null });

    await reviewRunForLearning(db, randomUUID());

    expect(completeTextMock).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(0);
  });

  it("no-ops when completeText returns null (feature disabled)", async () => {
    const run = runRow();
    const { db, inserted } = fakeDb({ runRow: run });
    completeTextMock.mockResolvedValue(null);

    await expect(reviewRunForLearning(db, run.id)).resolves.toBeUndefined();
    expect(inserted).toHaveLength(0);
  });

  it("includes issue title/description context when contextSnapshot has an issueId", async () => {
    const run = runRow({ contextSnapshot: { issueId: randomUUID() } });
    const { db } = fakeDb({
      runRow: run,
      issueRow: { title: "Fix the login bug", description: "Users get a 500 on login." },
    });
    completeTextMock.mockResolvedValue("[]");

    await reviewRunForLearning(db, run.id);

    expect(completeTextMock).toHaveBeenCalledTimes(1);
    const prompt = completeTextMock.mock.calls[0][0].prompt;
    expect(prompt).toContain("Fix the login bug");
    expect(prompt).toContain("Users get a 500 on login.");
    expect(prompt).toContain(JSON.stringify(run.resultJson));
  });

  it("never throws even when the db itself fails", async () => {
    const { db, inserted } = fakeDb({ failSelect: true });

    await expect(reviewRunForLearning(db, randomUUID())).resolves.toBeUndefined();
    expect(inserted).toHaveLength(0);
  });
});

describe("recallForAgent", () => {
  it("formats the latest learnings as a text block", async () => {
    const { db } = fakeDb({
      learningRows: [
        { kind: "correction", content: "Use pnpm, not npm" },
        { kind: "fact", content: "Staging deploys from main" },
      ],
    });

    const block = await recallForAgent(db, randomUUID());

    expect(block).toBe(
      "Durable learnings from prior runs:\n" +
        "- [correction] Use pnpm, not npm\n" +
        "- [fact] Staging deploys from main",
    );
  });

  it("returns null when the agent has no learnings", async () => {
    const { db } = fakeDb({ learningRows: [] });
    await expect(recallForAgent(db, randomUUID())).resolves.toBeNull();
  });

  it("returns null instead of throwing when the db fails", async () => {
    const { db } = fakeDb({ failSelect: true });
    await expect(recallForAgent(db, randomUUID())).resolves.toBeNull();
  });
});

describe("contentHash", () => {
  it("is whitespace- and case-insensitive", () => {
    expect(contentHash("CI uses pnpm")).toBe(contentHash("ci   uses\npnpm "));
    expect(contentHash("a")).not.toBe(contentHash("b"));
  });
});
