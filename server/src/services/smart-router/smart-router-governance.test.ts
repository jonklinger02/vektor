import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";

import type { ResolvedRoutingTable } from "../routing-config.js";

vi.mock("../../adapters/index.js", () => ({
  listAdapterModels: vi.fn(async (type: string) => {
    if (type === "empty") return [];
    return [
      { id: "claude-opus-4-8", label: "Opus" },
      { id: "claude-haiku-4-5", label: "Haiku" },
      { id: "claude-sonnet-4-6", label: "Sonnet" },
    ];
  }),
}));

vi.mock("../routing-config.js", () => ({
  getRoutingTable: vi.fn(async () => null),
  isCanaryBucket: vi.fn(() => false),
}));

import { getRoutingTable, isCanaryBucket } from "../routing-config.js";
import { decideModelForDispatch } from "./index.js";

const mockedGetRoutingTable = vi.mocked(getRoutingTable);
const mockedIsCanaryBucket = vi.mocked(isCanaryBucket);

const fakeDb = {} as unknown as Db;

function governedTable(overrides: Partial<ResolvedRoutingTable> = {}): ResolvedRoutingTable {
  return {
    versionId: "version-active-1",
    version: 3,
    status: "active",
    // Deliberately inverted vs the built-in catalog: the table declares
    // sonnet the CHEAP lane so a table-driven decision is distinguishable
    // from a catalog-driven one.
    specs: [
      { model: "claude-sonnet-4-6", cost: 1, capability: 4 },
      { model: "claude-haiku-4-5", cost: 2, capability: 4 },
      { model: "claude-opus-4-8", cost: 4, capability: 4 },
    ],
    canary: null,
    ...overrides,
  };
}

beforeEach(() => {
  mockedGetRoutingTable.mockReset();
  mockedGetRoutingTable.mockResolvedValue(null);
  mockedIsCanaryBucket.mockReset();
  mockedIsCanaryBucket.mockReturnValue(false);
});

describe("smart-router governance: versioned tables override the catalog", () => {
  it("uses the governed table's ranks and stamps routingConfigVersionId", async () => {
    mockedGetRoutingTable.mockResolvedValue(governedTable());

    const decision = await decideModelForDispatch({
      adapterType: "claude_local",
      taskSummary: "Send the weekly status note", // routine → catalog would pick haiku
      configuredModel: null,
      db: fakeDb,
      companyId: "company-1",
      issueId: "issue-1",
    });

    expect(mockedGetRoutingTable).toHaveBeenCalledWith(fakeDb, "routine");
    expect(decision?.model).toBe("claude-sonnet-4-6"); // table's cheapest, not the catalog's
    expect(decision?.routingConfigVersionId).toBe("version-active-1");
    expect(decision?.canaryBucket).toBe(false);
    expect(decision?.reasoning).toContain("governed table");
    expect(decision?.fallbackChain).toEqual(["claude-haiku-4-5", "claude-opus-4-8"]);
  });

  it("does not consult governance at all without a db in the request", async () => {
    const decision = await decideModelForDispatch({
      adapterType: "claude_local",
      taskSummary: "Send the weekly status note",
      configuredModel: null,
    });

    expect(mockedGetRoutingTable).not.toHaveBeenCalled();
    expect(decision?.model).toBe("claude-haiku-4-5"); // built-in catalog
    expect(decision?.routingConfigVersionId).toBeNull();
  });

  it("canary bucket flips to the canary table's version id and specs", async () => {
    mockedGetRoutingTable.mockResolvedValue(
      governedTable({
        canary: {
          versionId: "version-canary-9",
          version: 4,
          percent: 25,
          specs: [{ model: "claude-opus-4-8", cost: 1, capability: 4 }],
        },
      }),
    );
    mockedIsCanaryBucket.mockReturnValue(true);

    const decision = await decideModelForDispatch({
      adapterType: "claude_local",
      taskSummary: "Send the weekly status note",
      configuredModel: null,
      db: fakeDb,
      companyId: "company-1",
      issueId: "issue-1",
    });

    expect(mockedIsCanaryBucket).toHaveBeenCalledWith("company-1", "issue-1", 25);
    expect(decision?.model).toBe("claude-opus-4-8");
    expect(decision?.routingConfigVersionId).toBe("version-canary-9");
    expect(decision?.canaryBucket).toBe(true);
    expect(decision?.reasoning).toContain("canary bucket");
  });

  it("outside the canary bucket the active table still applies", async () => {
    mockedGetRoutingTable.mockResolvedValue(
      governedTable({
        canary: {
          versionId: "version-canary-9",
          version: 4,
          percent: 25,
          specs: [{ model: "claude-opus-4-8", cost: 1, capability: 4 }],
        },
      }),
    );
    mockedIsCanaryBucket.mockReturnValue(false);

    const decision = await decideModelForDispatch({
      adapterType: "claude_local",
      taskSummary: "Send the weekly status note",
      configuredModel: null,
      db: fakeDb,
      companyId: "company-1",
      issueId: "issue-1",
    });

    expect(decision?.model).toBe("claude-sonnet-4-6");
    expect(decision?.routingConfigVersionId).toBe("version-active-1");
    expect(decision?.canaryBucket).toBe(false);
  });

  it("falls back to the catalog when the table names no model this adapter exposes", async () => {
    mockedGetRoutingTable.mockResolvedValue(
      governedTable({
        specs: [
          { model: "totally-unknown-model", cost: 1, capability: 4 },
          { model: "another-mystery", cost: 2, capability: 4 },
        ],
      }),
    );

    const decision = await decideModelForDispatch({
      adapterType: "claude_local",
      taskSummary: "Send the weekly status note",
      configuredModel: null,
      db: fakeDb,
      companyId: "company-1",
      issueId: "issue-1",
    });

    expect(decision?.model).toBe("claude-haiku-4-5"); // catalog fallback
    expect(decision?.routingConfigVersionId).toBeNull();
    expect(decision?.canaryBucket).toBe(false);
    expect(decision?.reasoning).not.toContain("governed table");
  });
});
