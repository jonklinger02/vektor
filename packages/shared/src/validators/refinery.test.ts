import { describe, expect, it } from "vitest";
import {
  extractRefineryProposal,
  stripRefinerySignals,
  refineryChatRequestSchema,
} from "./refinery.js";

describe("refinery signals", () => {
  const signal =
    'Plan looks good.\n%%ACTIONS%%{"proposal":{"kind":"task","title":"Fix CSV import","description":"Handle BOM"}}%%/ACTIONS%%\nAnything else?';

  it("extracts a valid proposal", () => {
    expect(extractRefineryProposal(signal)).toEqual({
      kind: "task",
      title: "Fix CSV import",
      description: "Handle BOM",
    });
  });

  it("returns null for malformed JSON without throwing", () => {
    expect(extractRefineryProposal("%%ACTIONS%%{nope%%/ACTIONS%%")).toBeNull();
  });

  it("returns null for an unknown kind", () => {
    expect(
      extractRefineryProposal('%%ACTIONS%%{"proposal":{"kind":"epic","title":"x","description":"y"}}%%/ACTIONS%%'),
    ).toBeNull();
  });

  it("strips complete and dangling signals from display text", () => {
    expect(stripRefinerySignals(signal)).toBe("Plan looks good.\n\nAnything else?");
    expect(stripRefinerySignals('before %%ACTIONS%%{"partial')).toBe("before");
  });

  it("chat request requires message and model", () => {
    expect(refineryChatRequestSchema.safeParse({ message: "hi", model: "ollama/gpt-oss:20b" }).success).toBe(true);
    expect(refineryChatRequestSchema.safeParse({ message: "" }).success).toBe(false);
  });
});
