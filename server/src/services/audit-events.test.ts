import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Db } from "@paperclipai/db";

// The real logger creates its log directory at import time — keep the unit
// test hermetic (same seam as agent-learning.test.ts).
vi.mock("../middleware/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { logger } from "../middleware/logger.js";
import { emitAuditEvent, listAuditEvents, MAX_AUDIT_EVENTS_LIMIT } from "./audit-events.js";

const warnMock = vi.mocked(logger.warn);

/**
 * The audit-event service takes its Db as an argument (same seam as
 * company-heartbeat-policy.test.ts), so the test double is a vi.fn-backed
 * fake Db whose insert().values() and select().from().where().orderBy().limit()
 * chains record their arguments and resolve/reject canned results.
 */
function fakeDb(opts: {
  rows?: unknown[];
  insertRejects?: boolean;
  insertThrowsSync?: boolean;
} = {}) {
  const insertedValues: unknown[] = [];
  const whereArgs: unknown[] = [];
  const limitArgs: number[] = [];

  const db = {
    insert: vi.fn(() => {
      if (opts.insertThrowsSync) throw new Error("insert exploded synchronously");
      return {
        values: vi.fn((values: unknown) => {
          insertedValues.push(values);
          return opts.insertRejects
            ? Promise.reject(new Error("db unavailable"))
            : Promise.resolve([]);
        }),
      };
    }),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn((condition: unknown) => {
          whereArgs.push(condition);
          return {
            orderBy: vi.fn(() => ({
              limit: vi.fn((limit: number) => {
                limitArgs.push(limit);
                return Promise.resolve(opts.rows ?? []);
              }),
            })),
          };
        }),
      })),
    })),
  } as unknown as Db;

  return { db, insertedValues, whereArgs, limitArgs };
}

async function flushMicrotasks() {
  await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  warnMock.mockClear();
});

describe("emitAuditEvent", () => {
  it("inserts a normalized row", async () => {
    const { db, insertedValues } = fakeDb();
    emitAuditEvent(db, {
      companyId: "company-1",
      actorUserId: "user-1",
      actorType: "user",
      action: "company.role_changed",
      subjectType: "company_membership",
      subjectId: "member-1",
      details: { membershipRole: "admin" },
    });
    await flushMicrotasks();

    expect(insertedValues).toEqual([
      {
        companyId: "company-1",
        actorUserId: "user-1",
        actorType: "user",
        action: "company.role_changed",
        subjectType: "company_membership",
        subjectId: "member-1",
        details: { membershipRole: "admin" },
      },
    ]);
    expect(warnMock).not.toHaveBeenCalled();
  });

  it("defaults omitted fields to null (instance scope)", async () => {
    const { db, insertedValues } = fakeDb();
    emitAuditEvent(db, { actorType: "system", action: "routing.version_promoted" });
    await flushMicrotasks();

    expect(insertedValues).toEqual([
      {
        companyId: null,
        actorUserId: null,
        actorType: "system",
        action: "routing.version_promoted",
        subjectType: null,
        subjectId: null,
        details: null,
      },
    ]);
  });

  it("never throws when the insert rejects, and logs a warning instead", async () => {
    const { db } = fakeDb({ insertRejects: true });
    expect(() =>
      emitAuditEvent(db, { actorType: "user", action: "budget.policy_changed" }),
    ).not.toThrow();
    await flushMicrotasks();

    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(warnMock.mock.calls[0]?.[1]).toBe("audit event emission failed");
  });

  it("never throws when the insert builder throws synchronously", async () => {
    const { db } = fakeDb({ insertThrowsSync: true });
    expect(() =>
      emitAuditEvent(db, { actorType: "agent", action: "company.export" }),
    ).not.toThrow();
    await flushMicrotasks();

    expect(warnMock).toHaveBeenCalledTimes(1);
  });
});

describe("listAuditEvents", () => {
  it("defaults the limit to 50 when omitted", async () => {
    const { db, limitArgs } = fakeDb();
    await listAuditEvents(db);
    expect(limitArgs).toEqual([50]);
  });

  it("clamps the limit to the 200 maximum", async () => {
    const { db, limitArgs } = fakeDb();
    await listAuditEvents(db, { limit: 9999 });
    expect(limitArgs).toEqual([MAX_AUDIT_EVENTS_LIMIT]);
    expect(MAX_AUDIT_EVENTS_LIMIT).toBe(200);
  });

  it("falls back to the default for non-positive or non-finite limits", async () => {
    const { db, limitArgs } = fakeDb();
    await listAuditEvents(db, { limit: 0 });
    await listAuditEvents(db, { limit: -5 });
    await listAuditEvents(db, { limit: Number.NaN });
    expect(limitArgs).toEqual([50, 50, 50]);
  });

  it("floors fractional limits", async () => {
    const { db, limitArgs } = fakeDb();
    await listAuditEvents(db, { limit: 3.9 });
    expect(limitArgs).toEqual([3]);
  });

  it("passes no where condition when no filters are given", async () => {
    const { db, whereArgs } = fakeDb();
    await listAuditEvents(db);
    expect(whereArgs).toEqual([undefined]);
  });

  it("composes company and action filters", async () => {
    const { db, whereArgs } = fakeDb();
    await listAuditEvents(db, { companyId: "company-1" });
    await listAuditEvents(db, { action: "company.export" });
    await listAuditEvents(db, { companyId: "company-1", action: "company.export" });
    expect(whereArgs).toHaveLength(3);
    for (const arg of whereArgs) {
      expect(arg).toBeDefined();
    }
  });

  it("returns the resolved rows", async () => {
    const rows = [{ id: "evt-1" }, { id: "evt-2" }];
    const { db } = fakeDb({ rows });
    await expect(listAuditEvents(db, { limit: 2 })).resolves.toEqual(rows);
  });
});
