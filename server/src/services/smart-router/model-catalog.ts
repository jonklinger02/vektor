import type { TaskClass } from "./types.js";

/**
 * Cost + capability ranking over model ids, by pattern. Adapters own their
 * model lists (AdapterModel[] from listAdapterModels); this catalog only
 * *orders* whatever ids an adapter exposes so the router can pick the
 * cheapest id that clears the task class's capability bar.
 *
 * Ranks are ordinal, not prices: cost 1 = cheapest lane, 4 = premium.
 * capability 1 = lightweight, 4 = frontier. Unknown ids get the
 * conservative middle (cost 3 / capability 2): never accidentally "cheap",
 * never trusted with high-stakes work.
 */

type ModelRank = { cost: number; capability: number };

const MODEL_RANK_PATTERNS: Array<{ pattern: RegExp; rank: ModelRank }> = [
  // Anthropic
  { pattern: /haiku/i, rank: { cost: 1, capability: 2 } },
  { pattern: /sonnet/i, rank: { cost: 2, capability: 3 } },
  { pattern: /opus|fable|mythos/i, rank: { cost: 4, capability: 4 } },
  // Ollama Cloud (open-weight lanes). Must precede the OpenAI rules so
  // "gpt-oss" can never drift into the gpt-5 family rule if these patterns
  // loosen later; sized-id rules run before the family rule (first match wins).
  { pattern: /gpt-oss:?120b/i, rank: { cost: 2, capability: 3 } },
  { pattern: /gpt-oss/i, rank: { cost: 1, capability: 2 } },
  { pattern: /qwen3|deepseek-v3\.?1|glm-4/i, rank: { cost: 2, capability: 3 } },
  // OpenAI
  { pattern: /mini|nano/i, rank: { cost: 1, capability: 2 } },
  { pattern: /gpt-5|o[0-9]/i, rank: { cost: 3, capability: 4 } },
  { pattern: /gpt-4/i, rank: { cost: 3, capability: 3 } },
  // Google
  { pattern: /flash/i, rank: { cost: 1, capability: 2 } },
  { pattern: /gemini.*pro|pro.*gemini/i, rank: { cost: 3, capability: 4 } },
  // xAI
  { pattern: /grok.*(fast|mini)/i, rank: { cost: 1, capability: 2 } },
  { pattern: /grok/i, rank: { cost: 3, capability: 3 } },
];

const UNKNOWN_RANK: ModelRank = { cost: 3, capability: 2 };

export function rankModel(modelId: string): ModelRank {
  // "mini/nano" must not downrank e.g. "gpt-5" — first match wins, so order
  // within a provider block runs cheap-pattern first deliberately: the more
  // specific cheap ids ("gpt-5-mini") hit the cheap rule before the family rule.
  for (const { pattern, rank } of MODEL_RANK_PATTERNS) {
    if (pattern.test(modelId)) return rank;
  }
  return UNKNOWN_RANK;
}

/**
 * Minimum capability per task class — the "quality bar". The router picks the
 * cheapest model whose capability clears the bar; classes that can tolerate a
 * lightweight lane get one, classes that can't never see it.
 */
export const CLASS_CAPABILITY_BAR: Record<TaskClass, number> = {
  routine: 1,
  structured_extraction: 2,
  image_visual: 2,
  code: 3,
  complex_reasoning: 4,
  high_stakes: 4,
};
