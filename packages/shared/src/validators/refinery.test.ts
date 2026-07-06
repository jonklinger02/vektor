import { describe, expect, it } from "vitest";
import {
  extractRefineryProposal,
  stripRefinerySignals,
  refineryChatRequestSchema,
  createStreamingSignalStripper,
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

describe("createStreamingSignalStripper", () => {
  it("never emits a signal or a fragment of it when the marker is split across pushes", () => {
    const stripper = createStreamingSignalStripper();
    const pushes = [
      "%%ACTI",
      `ONS%%${JSON.stringify({ proposal: { kind: "task", title: "x", description: "y" } })}%%/ACT`,
      "IONS%%tail",
    ];

    let out = "";
    for (const p of pushes) {
      const safe = stripper.push(p);
      expect(safe).not.toContain("%%ACTIONS%%");
      // A held-back partial marker must never be handed out as a trailing
      // fragment either — e.g. "...%%ACTI" must not be returned as-is.
      for (let n = 1; n < "%%ACTIONS%%".length; n++) {
        expect(safe.endsWith("%%ACTIONS%%".slice(0, n))).toBe(false);
      }
      out += safe;
    }
    out += stripper.flush();

    expect(out).toBe("tail");
  });

  it("passes plain text through unchanged across push boundaries", () => {
    const stripper = createStreamingSignalStripper();
    const parts = ["Hello ", "there, ", "how are ", "you?"];
    let out = "";
    for (const p of parts) out += stripper.push(p);
    out += stripper.flush();
    expect(out).toBe(parts.join(""));
  });

  it("eventually emits a literal %% that never becomes a signal, via flush", () => {
    const stripper = createStreamingSignalStripper();
    let out = "";
    out += stripper.push("50%");
    out += stripper.push("% done");
    out += stripper.flush();
    expect(out).toBe("50%% done");
  });

  it("flush() drops a trailing partial-marker prefix instead of leaking it", () => {
    const s = createStreamingSignalStripper();
    const a = s.push("hello ");
    const b = s.push("%%ACTI");
    const out = a + b + s.flush();
    expect(out).toBe("hello ");
    expect(out).not.toContain("%%ACTI");

    // The already-correct complete-open, unterminated-block case still holds.
    const s2 = createStreamingSignalStripper();
    const out2 = s2.push('before %%ACTIONS%%{"partial') + s2.flush();
    expect(out2).toBe("before ");
  });
});
