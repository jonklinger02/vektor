import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  classifyConfidentiality,
  evaluateConfidentialityGate,
  localInferenceAdapters,
  maxLevel,
} from "./confidentiality.js";

const ENV_KEY = "PAPERCLIP_LOCAL_INFERENCE_ADAPTERS";
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
});

describe("classifyConfidentiality", () => {
  it("classifies actual credential VALUES as restricted", () => {
    expect(classifyConfidentiality("Deploy with password: hunter2secret on staging")).toBe(
      "restricted",
    );
    expect(classifyConfidentiality("The api key = sk-abc123def456 needs rotating")).toBe(
      "restricted",
    );
    expect(
      classifyConfidentiality("-----BEGIN RSA PRIVATE KEY-----\nMIIEow..."),
    ).toBe("restricted");
  });

  it("mere MENTIONS of credentials are confidential, not restricted (operational text must stay dispatchable)", () => {
    expect(classifyConfidentiality("Rotate the admin password for staging")).toBe("confidential");
    expect(classifyConfidentiality("The vendor api key expired, generate a new one")).toBe(
      "confidential",
    );
  });

  it("classifies SSN-shaped digits as restricted", () => {
    expect(classifyConfidentiality("Customer record shows 123-45-6789 on file")).toBe("restricted");
  });

  it("classifies money/legal/HR terms as confidential", () => {
    expect(classifyConfidentiality("Draft the salary bands for the new level")).toBe("confidential");
    expect(classifyConfidentiality("Review the NDA before the call")).toBe("confidential");
  });

  it("plain text stays public", () => {
    expect(classifyConfidentiality("Say hello to the new teammate")).toBe("public");
  });

  it("floors at the company default (upward only)", () => {
    expect(classifyConfidentiality("Say hello to the new teammate", "confidential")).toBe(
      "confidential",
    );
  });

  it("never lowers a classification below what the text demands", () => {
    // restricted text + lower company default: stays restricted
    expect(
      classifyConfidentiality("Customer record shows 123-45-6789 on file", "internal"),
    ).toBe("restricted");
    // confidential text + public default: stays confidential
    expect(classifyConfidentiality("Prepare the severance package", "public")).toBe("confidential");
  });
});

describe("maxLevel", () => {
  it("returns the stricter of the two levels", () => {
    expect(maxLevel("public", "restricted")).toBe("restricted");
    expect(maxLevel("restricted", "public")).toBe("restricted");
    expect(maxLevel("internal", "confidential")).toBe("confidential");
    expect(maxLevel("internal", "internal")).toBe("internal");
  });
});

describe("localInferenceAdapters", () => {
  it("is empty by default and parses the comma-separated env var", () => {
    expect(localInferenceAdapters().size).toBe(0);
    process.env[ENV_KEY] = "opencode_local, my_ollama_adapter ,";
    expect(localInferenceAdapters()).toEqual(new Set(["opencode_local", "my_ollama_adapter"]));
  });
});

describe("evaluateConfidentialityGate", () => {
  it("blocks restricted work on a hosted adapter and says the task was NOT sent", () => {
    const verdict = evaluateConfidentialityGate({
      taskSummary: "Deploy with password: hunter2secret now",
      adapterType: "claude_local",
      companyDefault: "public",
      privacyMode: false,
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.level).toBe("restricted");
    if (verdict.allowed) throw new Error("expected a block");
    expect(verdict.reason).toContain("NOT sent");
    expect(verdict.reason).toContain("claude_local");
  });

  it("allows restricted work when the adapter is declared local via the env var", () => {
    process.env[ENV_KEY] = "opencode_local";
    const verdict = evaluateConfidentialityGate({
      taskSummary: "Deploy with password: hunter2secret now",
      adapterType: "opencode_local",
      companyDefault: "public",
      privacyMode: false,
    });
    expect(verdict).toEqual({ allowed: true, level: "restricted" });
  });

  it("privacy mode forces local inference even for public work", () => {
    const verdict = evaluateConfidentialityGate({
      taskSummary: "Say hello to the new teammate",
      adapterType: "claude_local",
      companyDefault: "public",
      privacyMode: true,
    });
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) throw new Error("expected a block");
    expect(verdict.reason).toContain("privacy mode");
    expect(verdict.reason).toContain("NOT sent");
  });

  it("privacy mode + local adapter is allowed", () => {
    process.env[ENV_KEY] = "opencode_local";
    const verdict = evaluateConfidentialityGate({
      taskSummary: "Say hello to the new teammate",
      adapterType: "opencode_local",
      companyDefault: "public",
      privacyMode: true,
    });
    expect(verdict.allowed).toBe(true);
  });

  it("public work on a hosted adapter passes", () => {
    const verdict = evaluateConfidentialityGate({
      taskSummary: "Say hello to the new teammate",
      adapterType: "claude_local",
      companyDefault: "public",
      privacyMode: false,
    });
    expect(verdict).toEqual({ allowed: true, level: "public" });
  });

  it("company default restricted blocks hosted adapters even for bland text", () => {
    const verdict = evaluateConfidentialityGate({
      taskSummary: "Say hello to the new teammate",
      adapterType: "claude_local",
      companyDefault: "restricted",
      privacyMode: false,
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.level).toBe("restricted");
  });
});
