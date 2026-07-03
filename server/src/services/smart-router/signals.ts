import type { TaskClass, TaskSignal } from "./types.js";

/**
 * Programmatic task classification — keyword/pattern rules, no model call.
 * Ported from the Vektor platform's rule-set (PRD: "applies a deterministic
 * rule-set to classify task class ... falls back to a single small
 * classification LLM call ONLY when rules cannot classify confidently";
 * the LLM fallback is deliberately NOT ported — an unconfident
 * classification simply routes as `routine`, which is always safe because
 * quality bars only ever *raise* the model floor).
 */

const CLASS_PATTERNS: Array<{ type: TaskClass; pattern: RegExp; weight: number }> = [
  { type: "image_visual", pattern: /\b(image|screenshot|diagram|logo|render|photo|visual|figma|mockup|svg|png)\b/i, weight: 0.9 },
  { type: "code", pattern: /\b(bug|fix|refactor|implement|compile|test|typescript|python|api|endpoint|function|deploy|migration|stack ?trace|error|repo|branch|merge|pr|pull request)\b/i, weight: 0.8 },
  { type: "structured_extraction", pattern: /\b(extract|parse|csv|json|xml|table|spreadsheet|scrape|normalize|dedupe|import|export)\b/i, weight: 0.8 },
  { type: "high_stakes", pattern: /\b(legal|contract|compliance|invoice|payment|payroll|tax|security|credential|production incident|outage|customer[- ]facing|irreversible)\b/i, weight: 0.9 },
  { type: "complex_reasoning", pattern: /\b(architect|design doc|strategy|analyz[es]|research|evaluate|trade[- ]?offs?|plan|roadmap|investigate|root cause|postmortem)\b/i, weight: 0.7 },
];

const CONFIDENCE_FLOOR = 0.5;

/** Derive ranked task signals from the task text. Always returns >= 1 signal. */
export function deriveTaskSignals(taskSummary: string): TaskSignal[] {
  const text = taskSummary.slice(0, 4000);
  const signals: TaskSignal[] = [];
  for (const rule of CLASS_PATTERNS) {
    const matches = text.match(new RegExp(rule.pattern.source, "gi"));
    if (!matches) continue;
    // Confidence grows with match count but saturates; weight sets the ceiling.
    const confidence = Math.min(rule.weight, 0.4 + matches.length * 0.15);
    signals.push({ type: rule.type, confidence });
  }
  signals.sort((a, b) => b.confidence - a.confidence);
  if (signals.length === 0 || signals[0]!.confidence < CONFIDENCE_FLOOR) {
    return [{ type: "routine", confidence: 1 }, ...signals];
  }
  return signals;
}

/** The single class the router routes by (highest-confidence signal). */
export function dominantTaskClass(taskSummary: string): TaskClass {
  return deriveTaskSignals(taskSummary)[0]!.type;
}
