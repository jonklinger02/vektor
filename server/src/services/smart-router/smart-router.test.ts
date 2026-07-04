import { describe, expect, it, vi } from "vitest";

import { CLASS_CAPABILITY_BAR, rankModel } from "./model-catalog.js";
import { deriveTaskSignals, dominantTaskClass } from "./signals.js";

vi.mock("../../adapters/index.js", () => ({
  listAdapterModels: vi.fn(async (type: string) => {
    if (type === "empty") return [];
    if (type === "boom") throw new Error("registry unavailable");
    return [
      { id: "claude-opus-4-8", label: "Opus" },
      { id: "claude-haiku-4-5", label: "Haiku" },
      { id: "claude-sonnet-4-6", label: "Sonnet" },
    ];
  }),
}));

import { decideModelForDispatch } from "./index.js";

describe("signals: programmatic task classification", () => {
  it("classifies code work", () => {
    expect(dominantTaskClass("Fix the login bug and add a regression test")).toBe("code");
  });

  it("classifies high-stakes work", () => {
    expect(dominantTaskClass("Review the customer contract for compliance issues")).toBe(
      "high_stakes",
    );
  });

  it("classifies extraction work", () => {
    expect(dominantTaskClass("Parse the vendor CSV and normalize the columns")).toBe(
      "structured_extraction",
    );
  });

  it("falls back to routine when nothing matches confidently", () => {
    expect(dominantTaskClass("Say hello to the new teammate")).toBe("routine");
    const signals = deriveTaskSignals("Say hello to the new teammate");
    expect(signals[0]).toEqual({ type: "routine", confidence: 1 });
  });

  it("confidence grows with match count but saturates at the rule weight", () => {
    const one = deriveTaskSignals("fix it")[0]!;
    const many = deriveTaskSignals("fix the bug in the api endpoint test deploy")[0]!;
    expect(many.type).toBe("code");
    expect(many.confidence).toBeGreaterThan(one.confidence);
    expect(many.confidence).toBeLessThanOrEqual(0.8);
  });
});

describe("model catalog ranking", () => {
  it("orders the anthropic lanes by cost", () => {
    expect(rankModel("claude-haiku-4-5").cost).toBeLessThan(rankModel("claude-sonnet-4-6").cost);
    expect(rankModel("claude-sonnet-4-6").cost).toBeLessThan(rankModel("claude-opus-4-8").cost);
  });

  it("unknown ids get the conservative middle rank", () => {
    expect(rankModel("mystery-model-9000")).toEqual({ cost: 3, capability: 2 });
  });

  it("ranks Ollama Cloud lanes (sized gpt-oss before family, never the gpt-5 rule)", () => {
    expect(rankModel("gpt-oss:20b")).toEqual({ cost: 1, capability: 2 });
    expect(rankModel("gpt-oss:120b")).toEqual({ cost: 2, capability: 3 });
    expect(rankModel("qwen3-coder:480b")).toEqual({ cost: 2, capability: 3 });
    expect(rankModel("deepseek-v3.1:671b")).toEqual({ cost: 2, capability: 3 });
    expect(rankModel("glm-4.6")).toEqual({ cost: 2, capability: 3 });
  });

  it("every task class has a capability bar", () => {
    for (const bar of Object.values(CLASS_CAPABILITY_BAR)) {
      expect(bar).toBeGreaterThanOrEqual(1);
      expect(bar).toBeLessThanOrEqual(4);
    }
  });
});

describe("decideModelForDispatch: cheapest model that clears the bar", () => {
  it("routes routine work to the cheapest lane", async () => {
    const decision = await decideModelForDispatch({
      adapterType: "claude_local",
      taskSummary: "Send the weekly status note",
      configuredModel: "claude-opus-4-8",
    });
    expect(decision?.taskClass).toBe("routine");
    expect(decision?.model).toBe("claude-haiku-4-5");
    expect(decision?.fallbackChain).toEqual(["claude-sonnet-4-6", "claude-opus-4-8"]);
  });

  it("routes code work past the cheap lane (bar 3 → sonnet)", async () => {
    const decision = await decideModelForDispatch({
      adapterType: "claude_local",
      taskSummary: "Refactor the api endpoint and fix the failing test",
      configuredModel: null,
    });
    expect(decision?.taskClass).toBe("code");
    expect(decision?.model).toBe("claude-sonnet-4-6");
  });

  it("routes high-stakes work to the frontier lane only", async () => {
    const decision = await decideModelForDispatch({
      adapterType: "claude_local",
      taskSummary: "Prepare the legal contract addendum for the payroll vendor",
      configuredModel: null,
    });
    expect(decision?.taskClass).toBe("high_stakes");
    expect(decision?.model).toBe("claude-opus-4-8");
    expect(decision?.fallbackChain).toEqual([]);
  });

  it("keeps the cheap lane under a tier ceiling of 1 on routine work", async () => {
    const decision = await decideModelForDispatch({
      adapterType: "claude_local",
      taskSummary: "Send the weekly status note",
      configuredModel: null,
      tierCostCeiling: 1,
    });
    expect(decision?.taskClass).toBe("routine");
    expect(decision?.model).toBe("claude-haiku-4-5");
    // Only haiku (cost 1) survives the ceiling, so no fallbacks remain.
    expect(decision?.fallbackChain).toEqual([]);
  });

  it("degrades high-stakes work to the most capable in-ceiling model at ceiling 2", async () => {
    const decision = await decideModelForDispatch({
      adapterType: "claude_local",
      taskSummary: "Prepare the legal contract addendum for the payroll vendor",
      configuredModel: null,
      tierCostCeiling: 2,
    });
    expect(decision?.taskClass).toBe("high_stakes");
    // Bar 4 is unmeetable within cost <= 2: capped degradation picks sonnet
    // (most capable in-ceiling), never opus past the ceiling.
    expect(decision?.model).toBe("claude-sonnet-4-6");
    expect(decision?.reasoning).toMatch(/tier ceiling 2/);
    expect(decision?.fallbackChain).toEqual(["claude-haiku-4-5"]);
  });

  it("a null ceiling leaves routing unchanged", async () => {
    const decision = await decideModelForDispatch({
      adapterType: "claude_local",
      taskSummary: "Prepare the legal contract addendum for the payroll vendor",
      configuredModel: null,
      tierCostCeiling: null,
    });
    expect(decision?.model).toBe("claude-opus-4-8");
    expect(decision?.reasoning).not.toMatch(/ceiling/);
  });

  it("fails open on an empty model list", async () => {
    await expect(
      decideModelForDispatch({ adapterType: "empty", taskSummary: "anything", configuredModel: null }),
    ).resolves.toBeNull();
  });

  it("fails open when the registry throws", async () => {
    await expect(
      decideModelForDispatch({ adapterType: "boom", taskSummary: "anything", configuredModel: null }),
    ).resolves.toBeNull();
  });
});
