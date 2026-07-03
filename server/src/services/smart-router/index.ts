import type { Db } from "@paperclipai/db";
import { listAdapterModels } from "../../adapters/index.js";
import { getRoutingTable, isCanaryBucket } from "../routing-config.js";
import { dominantTaskClass } from "./signals.js";
import { CLASS_CAPABILITY_BAR, rankModel } from "./model-catalog.js";
import type { SmartRouterDecision, SmartRouterRequest } from "./types.js";

export type { SmartRouterDecision, SmartRouterRequest, TaskClass, TaskSignal } from "./types.js";
export { deriveTaskSignals, dominantTaskClass } from "./signals.js";
export { rankModel, CLASS_CAPABILITY_BAR } from "./model-catalog.js";

/**
 * Decide the model for one dispatch: classify the task (programmatic, zero
 * tokens), then pick the CHEAPEST model in the agent's adapter model list
 * whose capability clears the task class's quality bar.
 *
 * Fail-open contract (mirrors the Vektor reference implementation): any
 * error, an empty model list, or no qualifying candidate returns null — the
 * caller keeps the agent's configured default exactly as before the router
 * existed. A null decision can never make dispatch worse.
 */
export async function decideModelForDispatch(
  request: SmartRouterRequest,
): Promise<SmartRouterDecision | null> {
  try {
    const taskClass = dominantTaskClass(request.taskSummary);
    const bar = CLASS_CAPABILITY_BAR[taskClass];

    const models = await listAdapterModels(request.adapterType);
    if (!models || models.length === 0) return null;

    const ceiling = request.tierCostCeiling ?? null;

    // Routing governance: a versioned table for this class overrides the
    // built-in catalog's ranks — for the models it names that this adapter
    // actually exposes. Canary bucketing is a stable hash of
    // (companyId, issueId), so an issue never flip-flops across retries.
    let routingConfigVersionId: string | null = null;
    let canaryBucket = false;
    let governedRanks: Map<string, { cost: number; capability: number }> | null = null;
    if (request.db) {
      const table = await getRoutingTable(request.db as Db, taskClass);
      if (table) {
        let specs = table.specs;
        routingConfigVersionId = table.versionId;
        if (table.canary && request.companyId && request.issueId) {
          if (isCanaryBucket(request.companyId, request.issueId, table.canary.percent)) {
            specs = table.canary.specs;
            routingConfigVersionId = table.canary.versionId;
            canaryBucket = true;
          }
        }
        const adapterModelIds = new Set(models.map((m) => m.id));
        const usable = specs.filter((s) => adapterModelIds.has(s.model));
        if (usable.length > 0) {
          governedRanks = new Map(
            usable.map((s) => [s.model, { cost: s.cost, capability: s.capability }]),
          );
        } else {
          // Table names no model this adapter exposes — catalog fallback.
          routingConfigVersionId = null;
          canaryBucket = false;
        }
      }
    }

    const ranked = governedRanks
      ? [...governedRanks.entries()].map(([id, rank]) => ({ id, rank }))
      : models.map((m) => ({ id: m.id, rank: rankModel(m.id) }));
    const withinCeiling = ceiling === null ? ranked : ranked.filter((m) => m.rank.cost <= ceiling);
    if (withinCeiling.length === 0) return null;

    let qualifying = withinCeiling
      .filter((m) => m.rank.capability >= bar)
      .sort((a, b) => a.rank.cost - b.rank.cost || b.rank.capability - a.rank.capability);
    let capped = false;
    if (qualifying.length === 0) {
      // The allocation ceiling makes the bar unmeetable: degrade to the most
      // capable model the ceiling allows rather than failing open past it.
      capped = true;
      qualifying = [...withinCeiling].sort(
        (a, b) => b.rank.capability - a.rank.capability || a.rank.cost - b.rank.cost,
      );
    }

    const chosen = qualifying[0]!;
    // If the choice is exactly the configured default, still return the
    // decision — the audit trail ("why this model") is the point.
    return {
      model: chosen.id,
      taskClass,
      classificationMethod: "rule",
      reasoning:
        `Task classified as ${taskClass} (capability bar ${bar}); ` +
        (capped
          ? `allocation tier ceiling ${ceiling} makes the bar unmeetable — degraded to most capable in-ceiling model ${chosen.id} on ${request.adapterType}`
          : `cheapest qualifying model on ${request.adapterType} is ${chosen.id}`) +
        (routingConfigVersionId
          ? ` [governed table ${routingConfigVersionId.slice(0, 8)}${canaryBucket ? ", canary bucket" : ""}]`
          : "") +
        (request.configuredModel && request.configuredModel !== chosen.id
          ? ` (agent default: ${request.configuredModel})`
          : ""),
      fallbackChain: qualifying.slice(1).map((m) => m.id),
      routingConfigVersionId,
      canaryBucket,
      capped,
    };
  } catch {
    return null;
  }
}
