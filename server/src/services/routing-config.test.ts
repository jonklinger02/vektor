import { describe, expect, it } from "vitest";

import {
  assertTaskClass,
  canaryBucketValue,
  configHash,
  isCanaryBucket,
  validateSpecs,
} from "./routing-config.js";
import { ALL_TASK_CLASSES } from "./smart-router/types.js";

/**
 * The lifecycle functions (propose/promote/freeze/rollback) are exercised
 * end-to-end through the governance routes; the seams tested here are the
 * pure building blocks every lifecycle call depends on. (For DB-backed
 * services the fake-Db-with-chainable-vi.fn pattern from
 * company-heartbeat-policy.test.ts applies — none of these need a Db.)
 */

describe("validateSpecs", () => {
  it("rejects an empty array", () => {
    expect(() => validateSpecs([])).toThrow(/non-empty array/);
  });

  it("rejects non-array input", () => {
    expect(() => validateSpecs(null)).toThrow(/non-empty array/);
    expect(() => validateSpecs("claude-haiku-4-5")).toThrow(/non-empty array/);
    expect(() => validateSpecs({ model: "claude-haiku-4-5", cost: 1, capability: 2 })).toThrow(
      /non-empty array/,
    );
  });

  it("drops malformed entries and rejects when nothing valid remains", () => {
    expect(() =>
      validateSpecs([
        { model: "", cost: 1, capability: 2 },
        { model: "x", cost: "1", capability: 2 },
        { cost: 1, capability: 2 },
        42,
        null,
      ]),
    ).toThrow(/non-empty array/);
  });

  it("rejects cost or capability outside 1..4", () => {
    expect(() => validateSpecs([{ model: "m", cost: 0, capability: 2 }])).toThrow(/within 1\.\.4/);
    expect(() => validateSpecs([{ model: "m", cost: 5, capability: 2 }])).toThrow(/within 1\.\.4/);
    expect(() => validateSpecs([{ model: "m", cost: 2, capability: 0 }])).toThrow(/within 1\.\.4/);
    expect(() => validateSpecs([{ model: "m", cost: 2, capability: 9 }])).toThrow(/within 1\.\.4/);
  });

  it("returns the parsed specs when every entry is valid", () => {
    const specs = validateSpecs([
      { model: "claude-haiku-4-5", cost: 1, capability: 2 },
      { model: "claude-opus-4-8", cost: 4, capability: 4 },
    ]);
    expect(specs).toEqual([
      { model: "claude-haiku-4-5", cost: 1, capability: 2 },
      { model: "claude-opus-4-8", cost: 4, capability: 4 },
    ]);
  });
});

describe("assertTaskClass", () => {
  it("accepts every known task class", () => {
    for (const taskClass of ALL_TASK_CLASSES) {
      expect(assertTaskClass(taskClass)).toBe(taskClass);
    }
  });

  it("rejects unknown classes with the valid list in the message", () => {
    expect(() => assertTaskClass("underwater_basket_weaving")).toThrow(
      /Unknown task class "underwater_basket_weaving".*routine/,
    );
  });
});

describe("canaryBucketValue", () => {
  it("is deterministic per (company, issue)", () => {
    const a = canaryBucketValue("company-1", "issue-1");
    expect(canaryBucketValue("company-1", "issue-1")).toBe(a);
    expect(canaryBucketValue("company-1", "issue-1")).toBe(a);
  });

  it("always lands in 0..99", () => {
    for (let i = 0; i < 200; i++) {
      const value = canaryBucketValue(`company-${i}`, `issue-${i}`);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(100);
      expect(Number.isInteger(value)).toBe(true);
    }
  });

  it("varies across inputs (not a constant hash)", () => {
    const values = new Set<number>();
    for (let i = 0; i < 100; i++) {
      values.add(canaryBucketValue("company", `issue-${i}`));
    }
    expect(values.size).toBeGreaterThan(1);
  });
});

describe("isCanaryBucket", () => {
  it("percent 0 (and below) is never in the canary", () => {
    expect(isCanaryBucket("c", "i", 0)).toBe(false);
    expect(isCanaryBucket("c", "i", -5)).toBe(false);
  });

  it("percent 100 (and above) is always in the canary", () => {
    expect(isCanaryBucket("c", "i", 100)).toBe(true);
    expect(isCanaryBucket("c", "i", 250)).toBe(true);
  });

  it("matches bucketValue < percent in between, stable per (company, issue)", () => {
    for (let i = 0; i < 50; i++) {
      const companyId = `company-${i}`;
      const issueId = `issue-${i}`;
      const bucket = canaryBucketValue(companyId, issueId);
      for (const percent of [1, 25, 50, 75, 99]) {
        const expected = bucket < percent;
        expect(isCanaryBucket(companyId, issueId, percent)).toBe(expected);
        // Re-evaluating never flips the verdict (no per-call randomness).
        expect(isCanaryBucket(companyId, issueId, percent)).toBe(expected);
      }
    }
  });
});

describe("configHash", () => {
  const specs = [
    { model: "claude-haiku-4-5", cost: 1, capability: 2 },
    { model: "claude-sonnet-4-6", cost: 2, capability: 3 },
  ];

  it("is stable for identical specs", () => {
    expect(configHash(specs)).toBe(configHash([...specs.map((s) => ({ ...s }))]));
  });

  it("is a 16-char hex prefix", () => {
    expect(configHash(specs)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("changes when the specs change", () => {
    const changed = [{ ...specs[0]!, cost: 2 }, specs[1]!];
    expect(configHash(changed)).not.toBe(configHash(specs));
  });

  it("is order-sensitive (the table is ordered)", () => {
    expect(configHash([specs[1]!, specs[0]!])).not.toBe(configHash(specs));
  });
});
