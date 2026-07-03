import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { companyHeartbeatConfigs, heartbeatRuns } from "@paperclipai/db";

import {
  admitDispatch,
  derivePolicy,
  dispatchMinIntervalMs,
  invalidatePolicyCache,
  isValidAllocation,
  tierCostCeiling,
} from "./company-heartbeat-policy.js";

type ConfigRow = {
  id: string;
  companyId: string;
  processors: number;
  memory: number;
  trust: number;
  enabled: boolean;
  lastDispatchAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function configRow(overrides: Partial<ConfigRow> = {}): ConfigRow {
  return {
    id: randomUUID(),
    companyId: randomUUID(),
    processors: 1,
    memory: 1,
    trust: 2,
    enabled: true,
    lastDispatchAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/**
 * The policy service takes its Db as an argument (unlike the smart-router's
 * module-level adapter registry, which smart-router.test.ts stubs with
 * vi.mock), so the equivalent seam here is a vi.fn-backed fake Db whose
 * select().from(table).where() chain resolves canned rows per table.
 */
function fakeDb(opts: {
  configRow?: ConfigRow | null;
  activeRuns?: number;
  fail?: boolean;
} = {}): Db {
  const where = vi.fn((table: unknown) => {
    if (opts.fail) return Promise.reject(new Error("db unavailable"));
    if (table === companyHeartbeatConfigs) {
      return Promise.resolve(opts.configRow ? [opts.configRow] : []);
    }
    if (table === heartbeatRuns) {
      return Promise.resolve([{ value: opts.activeRuns ?? 0 }]);
    }
    return Promise.resolve([]);
  });
  return {
    select: vi.fn(() => ({
      from: (table: unknown) => ({
        where: () => where(table),
      }),
    })),
  } as unknown as Db;
}

beforeEach(() => {
  invalidatePolicyCache();
});

describe("isValidAllocation", () => {
  it("accepts integer splits within the trust ceiling", () => {
    expect(isValidAllocation(0, 0, 2)).toBe(true);
    expect(isValidAllocation(1, 1, 2)).toBe(true);
    expect(isValidAllocation(2, 0, 2)).toBe(true);
  });

  it("rejects non-integer values", () => {
    expect(isValidAllocation(1.5, 0, 2)).toBe(false);
    expect(isValidAllocation(0, 0.1, 2)).toBe(false);
    expect(isValidAllocation(Number.NaN, 0, 2)).toBe(false);
  });

  it("rejects negative values", () => {
    expect(isValidAllocation(-1, 0, 2)).toBe(false);
    expect(isValidAllocation(0, -1, 2)).toBe(false);
  });

  it("rejects a sum above trust", () => {
    expect(isValidAllocation(2, 1, 2)).toBe(false);
    expect(isValidAllocation(0, 3, 2)).toBe(false);
  });
});

describe("dispatchMinIntervalMs", () => {
  it("pauses dispatch entirely at 0 processors", () => {
    expect(dispatchMinIntervalMs(0)).toBe(Number.POSITIVE_INFINITY);
  });

  it("gives one dispatch per minute at 1 processor", () => {
    expect(dispatchMinIntervalMs(1)).toBe(60_000);
  });

  it("divides the interval per additional processor", () => {
    expect(dispatchMinIntervalMs(2)).toBe(30_000);
  });

  it("floors at 2s no matter how many processors", () => {
    expect(dispatchMinIntervalMs(60)).toBe(2_000);
  });
});

describe("tierCostCeiling", () => {
  it("maps memory to the cost-rank ceiling at each boundary", () => {
    expect(tierCostCeiling(0)).toBe(1);
    expect(tierCostCeiling(1)).toBe(1);
    expect(tierCostCeiling(2)).toBe(2);
    expect(tierCostCeiling(3)).toBe(2);
    expect(tierCostCeiling(4)).toBe(3);
    expect(tierCostCeiling(5)).toBe(3);
    expect(tierCostCeiling(6)).toBe(4);
    expect(tierCostCeiling(7)).toBe(4);
  });
});

describe("derivePolicy", () => {
  it("derives the full policy shape from an allocation", () => {
    expect(derivePolicy({ processors: 3, memory: 4, trust: 8 })).toEqual({
      processors: 3,
      memory: 4,
      trust: 8,
      maxConcurrentRuns: 3,
      dispatchMinIntervalMs: 20_000,
      tierCostCeiling: 3,
    });
  });

  it("never reports negative concurrency", () => {
    const policy = derivePolicy({ processors: 0, memory: 0, trust: 2 });
    expect(policy.maxConcurrentRuns).toBe(0);
    expect(policy.dispatchMinIntervalMs).toBe(Number.POSITIVE_INFINITY);
    expect(policy.tierCostCeiling).toBe(1);
  });
});

describe("admitDispatch", () => {
  it("admits when the company has no config row (not opted in)", async () => {
    const verdict = await admitDispatch(fakeDb({ configRow: null }), randomUUID());
    expect(verdict).toEqual({ admitted: true });
  });

  it("admits when the config row is disabled", async () => {
    const row = configRow({ enabled: false, processors: 0 });
    const verdict = await admitDispatch(fakeDb({ configRow: row }), row.companyId);
    expect(verdict).toEqual({ admitted: true });
  });

  it("refuses on cadence when the allocation has 0 processors", async () => {
    const row = configRow({ processors: 0 });
    const verdict = await admitDispatch(fakeDb({ configRow: row }), row.companyId);
    expect(verdict).toMatchObject({ admitted: false, reason: "cadence" });
    if (verdict.admitted) throw new Error("expected refusal");
    expect(verdict.detail).toContain("0 processors");
  });

  it("refuses on cadence when the last dispatch is within the interval", async () => {
    const row = configRow({
      processors: 1,
      lastDispatchAt: new Date(Date.now() - 1_000),
    });
    const verdict = await admitDispatch(fakeDb({ configRow: row }), row.companyId);
    expect(verdict).toMatchObject({ admitted: false, reason: "cadence" });
    if (verdict.admitted) throw new Error("expected refusal");
    expect(verdict.detail).toMatch(/one per 60s at 1 processor/);
    expect(verdict.detail).toMatch(/next slot in \d+s/);
  });

  it("refuses on concurrency when active runs meet the processor allocation", async () => {
    const row = configRow({ processors: 2, lastDispatchAt: null });
    const verdict = await admitDispatch(
      fakeDb({ configRow: row, activeRuns: 2 }),
      row.companyId,
    );
    expect(verdict).toMatchObject({ admitted: false, reason: "concurrency" });
    if (verdict.admitted) throw new Error("expected refusal");
    expect(verdict.detail).toContain("2 run(s) already active");
    expect(verdict.detail).toContain("permits 2 concurrent run(s)");
  });

  it("admits below the concurrency allocation once cadence clears", async () => {
    const row = configRow({ processors: 2, lastDispatchAt: new Date(Date.now() - 31_000) });
    const verdict = await admitDispatch(
      fakeDb({ configRow: row, activeRuns: 1 }),
      row.companyId,
    );
    expect(verdict).toEqual({ admitted: true });
  });

  it("fails open (admits) when the allocation lookup errors", async () => {
    const verdict = await admitDispatch(fakeDb({ fail: true }), randomUUID());
    expect(verdict).toEqual({ admitted: true });
  });
});
