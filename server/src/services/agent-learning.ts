import { createHash } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentLearnings, heartbeatRuns, issues } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { completeText } from "./llm-utility.js";

// Agent self-learning loop (ported from the vektor-app hermes-style
// learning.service):
//
//   • CAPTURE — after a heartbeat run reaches 'succeeded',
//     reviewRunForLearning() sends a compact transcript summary to a cheap
//     model and asks for a strict JSON array of durable learnings
//     ({kind, content}), dedupes them via a sha256 content hash against the
//     (agentId, contentHash) unique index, and persists new agent_learnings
//     rows. Best-effort: it NEVER throws into the run path.
//   • RECALL — recallForAgent() returns the agent's latest learnings as a
//     formatted text block for injection into the next dispatch context.

const VALID_KINDS: ReadonlySet<string> = new Set([
  "correction",
  "preference",
  "technique",
  "fact",
]);

const MAX_LEARNINGS_PER_REVIEW = 3;
const MAX_CONTENT_LEN = 500;
const MAX_RESULT_JSON_LEN = 6000;
const MAX_ISSUE_DESCRIPTION_LEN = 1500;
const DEFAULT_RECALL_LIMIT = 5;

const REVIEW_SYSTEM_PROMPT =
  "You are reviewing a completed agent run to extract DURABLE, REUSABLE learnings " +
  "that would help this agent on future runs: user corrections, stated preferences, " +
  "effective techniques, or stable facts. Ignore one-off task details and secrets. " +
  'Respond with ONLY a STRICT JSON array of objects {"kind":"...","content":"..."} ' +
  "where kind is one of correction|preference|technique|fact. Return at most 3 " +
  "entries. Return [] if nothing is worth remembering.";

export interface LearningCandidate {
  kind: string;
  content: string;
}

/**
 * RECALL: latest learnings for an agent, formatted for prompt injection.
 * Returns null when the agent has none (or on any failure — best-effort).
 */
export async function recallForAgent(
  db: Db,
  agentId: string,
  limit = DEFAULT_RECALL_LIMIT,
): Promise<string | null> {
  try {
    const rows = await db
      .select({ kind: agentLearnings.kind, content: agentLearnings.content })
      .from(agentLearnings)
      .where(eq(agentLearnings.agentId, agentId))
      .orderBy(desc(agentLearnings.createdAt))
      .limit(limit);
    if (rows.length === 0) return null;
    const lines = rows.map((row) => `- [${row.kind}] ${row.content}`);
    return `Durable learnings from prior runs:\n${lines.join("\n")}`;
  } catch (err) {
    logger.warn({ err, agentId }, "agent-learning recall failed (best-effort)");
    return null;
  }
}

/**
 * CAPTURE: extract + dedupe + persist learnings from a succeeded run.
 * Entirely best-effort — catches everything, never throws.
 */
export async function reviewRunForLearning(db: Db, runId: string): Promise<void> {
  try {
    const run = await db
      .select({
        id: heartbeatRuns.id,
        companyId: heartbeatRuns.companyId,
        agentId: heartbeatRuns.agentId,
        status: heartbeatRuns.status,
        resultJson: heartbeatRuns.resultJson,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!run || run.status !== "succeeded") return;

    const transcript = await buildTranscriptSummary(db, {
      companyId: run.companyId,
      contextSnapshot: run.contextSnapshot ?? null,
      resultJson: run.resultJson ?? null,
    });

    const raw = await completeText({
      system: REVIEW_SYSTEM_PROMPT,
      prompt: transcript,
      maxTokens: 512,
    });
    if (!raw) return; // no provider configured, or the call failed — silently disabled

    const candidates = parseLearnings(raw);
    if (candidates.length === 0) return;

    const seenHashes = new Set<string>();
    const rows: Array<typeof agentLearnings.$inferInsert> = [];
    for (const candidate of candidates.slice(0, MAX_LEARNINGS_PER_REVIEW)) {
      const content = candidate.content.slice(0, MAX_CONTENT_LEN);
      const hash = contentHash(content);
      if (seenHashes.has(hash)) continue; // within-batch dedupe
      seenHashes.add(hash);
      rows.push({
        companyId: run.companyId,
        agentId: run.agentId,
        kind: candidate.kind,
        content,
        contentHash: hash,
        sourceRunId: run.id,
      });
    }
    if (rows.length === 0) return;

    // Duplicates vs already-persisted learnings collide with the
    // (agent_id, content_hash) unique index and are silently skipped.
    await db
      .insert(agentLearnings)
      .values(rows)
      .onConflictDoNothing({ target: [agentLearnings.agentId, agentLearnings.contentHash] });
  } catch (err) {
    logger.warn({ err, runId }, "agent-learning review failed (best-effort)");
  }
}

/**
 * Fire-and-forget wrapper for the post-run capture path. Safe to call from
 * the run-finalization hot path — nothing can throw or reject out of it.
 */
export function queueRunLearningReview(db: Db, runId: string): void {
  void reviewRunForLearning(db, runId).catch(() => {});
}

async function buildTranscriptSummary(
  db: Db,
  run: {
    companyId: string;
    contextSnapshot: Record<string, unknown> | null;
    resultJson: Record<string, unknown> | null;
  },
): Promise<string> {
  const lines: string[] = [];

  const issueId =
    typeof run.contextSnapshot?.issueId === "string" && run.contextSnapshot.issueId.length > 0
      ? run.contextSnapshot.issueId
      : null;
  if (issueId) {
    try {
      const issue = await db
        .select({ title: issues.title, description: issues.description })
        .from(issues)
        .where(eq(issues.id, issueId))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (issue) {
        lines.push(`Task: ${issue.title}`);
        const description = issue.description?.trim();
        if (description) {
          lines.push(`Task description: ${description.slice(0, MAX_ISSUE_DESCRIPTION_LEN)}`);
        }
      }
    } catch {
      // issue lookup is optional context — proceed without it
    }
  }

  lines.push(`Run result: ${JSON.stringify(run.resultJson ?? {}).slice(0, MAX_RESULT_JSON_LEN)}`);
  return lines.join("\n");
}

export function parseLearnings(text: string): LearningCandidate[] {
  const arr = extractJsonArray(text);
  if (!arr) return [];
  const out: LearningCandidate[] = [];
  for (const item of arr) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    const kind = typeof rec.kind === "string" ? rec.kind.trim().toLowerCase() : "";
    const content = typeof rec.content === "string" ? rec.content.trim() : "";
    if (!VALID_KINDS.has(kind) || content.length === 0) continue;
    out.push({ kind, content });
  }
  return out;
}

export function contentHash(content: string): string {
  const normalized = content.toLowerCase().replace(/\s+/g, " ").trim();
  return createHash("sha256").update(normalized).digest("hex");
}

function extractJsonArray(text: string): unknown[] | null {
  const candidates: string[] = [];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) candidates.push(fence[1]);
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start !== -1 && end > start) candidates.push(text.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate.trim());
      if (Array.isArray(value)) return value;
    } catch {
      // try the next candidate
    }
  }
  return null;
}
