/**
 * Smart-Router (model-task matcher) — ported from the Vektor platform's
 * orchestration scheme (see VEKTOR-ORCHESTRATION-AND-HEARTBEAT.md).
 *
 * Purpose: for each dispatch, classify the task programmatically (zero LLM
 * tokens) and pick the CHEAPEST model that meets the task class's quality bar
 * from the assigned agent's adapter model list. Explicit human choices
 * (issue adapterConfig.model, a requested model profile) always win; the
 * router only fills the gap where today the agent's static default ran
 * everything regardless of task difficulty.
 */

export type TaskClass =
  | "image_visual"
  | "code"
  | "structured_extraction"
  | "high_stakes"
  | "complex_reasoning"
  | "routine";

export const ALL_TASK_CLASSES: TaskClass[] = [
  "image_visual",
  "code",
  "structured_extraction",
  "high_stakes",
  "complex_reasoning",
  "routine",
];

export type TaskSignal = {
  type: TaskClass;
  confidence: number;
};

export type SmartRouterRequest = {
  adapterType: string;
  /** Issue title + body (the task text the classifier reads). */
  taskSummary: string;
  /** The agent's currently-configured model, used as the safe fallback. */
  configuredModel: string | null;
  /**
   * Per-company model-tier cost ceiling from the heartbeat allocation
   * (1 cheapest … 4 premium); null = no ceiling. When the ceiling makes a
   * class's capability bar unmeetable, the router degrades to the most
   * capable model within the ceiling and says so in `reasoning`.
   */
  tierCostCeiling?: number | null;
  /**
   * Routing-governance context: when `db` is provided, the router consults
   * the versioned per-class routing tables (active + canary, with canary
   * bucketing by (companyId, issueId)) before the built-in catalog.
   */
  db?: unknown;
  companyId?: string | null;
  issueId?: string | null;
};

export type SmartRouterDecision = {
  /** The chosen model id (an id from the adapter's own model list). */
  model: string;
  taskClass: TaskClass;
  classificationMethod: "rule";
  /** Human-readable audit line. */
  reasoning: string;
  /** Remaining qualifying candidates, cheapest-first, for retry/fallback. */
  fallbackChain: string[];
  /** Governance version the table came from; null = built-in catalog. */
  routingConfigVersionId: string | null;
  /** True when this decision used the canary table for its class. */
  canaryBucket: boolean;
  /** True when an allocation tier ceiling degraded the choice. */
  capped: boolean;
};
