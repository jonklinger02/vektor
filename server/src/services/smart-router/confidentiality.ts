import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import { eq } from "drizzle-orm";

/**
 * Confidentiality gate (ported from the Vektor platform's confidentiality
 * model + llm-gateway confidentiality-gate). Sensitivity is classified
 * programmatically from the task text and floored at the company default;
 * RESTRICTED work (or a privacy-mode company) may only dispatch to adapters
 * whose inference is local — and when the assigned agent's adapter is not
 * local, the dispatch DEFERS with an explicit reason. It never silently
 * degrades to a hosted provider: the data does not leave the box.
 */

export type ConfidentialityLevel = "public" | "internal" | "confidential" | "restricted";

const LEVEL_ORDER: Record<ConfidentialityLevel, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};

export function maxLevel(a: ConfidentialityLevel, b: ConfidentialityLevel): ConfidentialityLevel {
  return LEVEL_ORDER[a] >= LEVEL_ORDER[b] ? a : b;
}

/**
 * Signals that raise a task's sensitivity. RESTRICTED triggers only on actual
 * secret-data SHAPES (a value being present), never on bare topic words —
 * operational text that merely *mentions* passwords (watchdog evidence,
 * security review issues) must not be blocked from dispatch. Topic words
 * raise to CONFIDENTIAL instead.
 */
const LEVEL_PATTERNS: Array<{ level: ConfidentialityLevel; pattern: RegExp }> = [
  // restricted: an actual secret/regulated value appears in the text
  { level: "restricted", pattern: /\b(password|api[ _-]?key|secret[ _-]?key|access[ _-]?token|credential)s?\b\s*(is|[:=])\s*["'`]?[^\s"'`]{6,}/i },
  { level: "restricted", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { level: "restricted", pattern: /\b\d{3}-\d{2}-\d{4}\b/ }, // SSN shape
  { level: "restricted", pattern: /\b(?:\d[ -]?){13,16}\b(?=.*\b(card|cvv|credit)\b)/i }, // PAN + card context
  // confidential: sensitive topics, personal/financial/legal/HR matter
  { level: "confidential", pattern: /\b(password|api[ _-]?key|secret[ _-]?key|private[ _-]?key|credential|ssn|social security|passport number|medical record|diagnosis|patient)\b/i },
  { level: "confidential", pattern: /\b(salary|payroll|compensation|term sheet|acquisition|nda|legal hold|disciplinary|termination|severance)\b/i },
  // internal: unreleased work product
  { level: "internal", pattern: /\b(internal only|do not share|unreleased|embargo|pre[- ]?announce)\b/i },
];

/** Classify the task text; result is floored at the company default level. */
export function classifyConfidentiality(
  taskSummary: string,
  companyDefault: ConfidentialityLevel = "public",
): ConfidentialityLevel {
  const text = taskSummary.slice(0, 4000);
  let level: ConfidentialityLevel = companyDefault;
  for (const rule of LEVEL_PATTERNS) {
    if (rule.pattern.test(text)) level = maxLevel(level, rule.level);
  }
  return level;
}

/**
 * Adapter types whose INFERENCE stays on hardware the operator controls.
 * Every built-in fork adapter fronts a hosted provider (the local CLIs still
 * send prompts to Anthropic/OpenAI/etc.), so the default set is EMPTY —
 * operators running genuinely local inference (e.g. an opencode+ollama
 * setup or a custom adapter) declare it explicitly:
 *   PAPERCLIP_LOCAL_INFERENCE_ADAPTERS=opencode_local,my_ollama_adapter
 */
export function localInferenceAdapters(): Set<string> {
  const raw = process.env.PAPERCLIP_LOCAL_INFERENCE_ADAPTERS ?? "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

export type ConfidentialityVerdict =
  | { allowed: true; level: ConfidentialityLevel }
  | { allowed: false; level: ConfidentialityLevel; reason: string };

/**
 * The gate: restricted work (or privacy-mode company) requires a
 * local-inference adapter. Confidential/internal/public pass in v1 (the
 * fork's adapters carry no per-provider trust grading to gate them on).
 */
export function evaluateConfidentialityGate(input: {
  taskSummary: string;
  adapterType: string;
  companyDefault: ConfidentialityLevel;
  privacyMode: boolean;
}): ConfidentialityVerdict {
  const level = classifyConfidentiality(input.taskSummary, input.companyDefault);
  const requiresLocal = input.privacyMode || level === "restricted";
  if (!requiresLocal) return { allowed: true, level };
  if (localInferenceAdapters().has(input.adapterType)) return { allowed: true, level };
  return {
    allowed: false,
    level,
    reason:
      `${input.privacyMode ? "Company privacy mode" : `Confidentiality level "${level}"`} requires a ` +
      `local-inference adapter; agent adapter "${input.adapterType}" sends prompts to a hosted provider. ` +
      `Assign a local-inference agent or set PAPERCLIP_LOCAL_INFERENCE_ADAPTERS. The task was NOT sent anywhere.`,
  };
}

/** Company confidentiality settings (columns added in migration 0131). Fail-safe: on error, treat as most-restrictive defaults OFF (public, no privacy mode) — matching pre-feature behavior. */
export async function getCompanyConfidentiality(
  db: Db,
  companyId: string,
): Promise<{ defaultLevel: ConfidentialityLevel; privacyMode: boolean }> {
  try {
    const row = await db
      .select({
        defaultConfidentiality: companies.defaultConfidentiality,
        privacyMode: companies.privacyMode,
      })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    const level = (row?.defaultConfidentiality ?? "public") as ConfidentialityLevel;
    return {
      defaultLevel: LEVEL_ORDER[level] !== undefined ? level : "public",
      privacyMode: row?.privacyMode ?? false,
    };
  } catch {
    return { defaultLevel: "public", privacyMode: false };
  }
}
