import { z } from "zod";

export const REFINERY_SESSION_STATUSES = ["active", "finalized", "archived"] as const;
export const REFINERY_PROPOSAL_KINDS = ["task", "goal", "project"] as const;
export type RefineryProposalKind = (typeof REFINERY_PROPOSAL_KINDS)[number];

export interface RefinerySession {
  id: string;
  ownerUserId: string;
  title: string;
  status: string;
  model: string | null;
  finalizedKind: string | null;
  finalizedEntityId: string | null;
  finalizedCompanyId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RefineryMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  body: string;
  model: string | null;
  contextExcluded: boolean;
  createdAt: string;
}

export interface RefineryModelOption {
  id: string;
  label: string;
  tier: "cheap" | "standard" | "frontier";
}

export const createRefinerySessionSchema = z.object({
  title: z.string().min(1).max(200).optional(),
});
export const updateRefinerySessionSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  status: z.enum(REFINERY_SESSION_STATUSES).optional(),
});
export const refineryChatRequestSchema = z.object({
  message: z.string().min(1),
  model: z.string().min(1),
});
export const refineryContextToggleSchema = z.object({
  contextExcluded: z.boolean(),
});

export const refineryProposalSchema = z.object({
  kind: z.enum(REFINERY_PROPOSAL_KINDS),
  title: z.string().min(1),
  description: z.string().min(1),
  priority: z.string().optional(),
  level: z.string().optional(),
});
export type RefineryProposal = z.infer<typeof refineryProposalSchema>;

const SIGNAL_RE = /%%ACTIONS%%([\s\S]*?)%%\/ACTIONS%%/g;
/** Matches an opened-but-unterminated signal at end of text (streaming tail). */
const DANGLING_SIGNAL_RE = /%%ACTIONS%%[\s\S]*$/;

/** Parse the FIRST well-formed proposal signal out of a model reply. */
export function extractRefineryProposal(text: string): RefineryProposal | null {
  for (const match of text.matchAll(SIGNAL_RE)) {
    try {
      const parsed = JSON.parse(match[1] ?? "");
      const result = refineryProposalSchema.safeParse(parsed?.proposal);
      if (result.success) return result.data;
    } catch {
      // fall through to next signal block, if any
    }
  }
  return null;
}

/** Remove complete AND dangling signal blocks from user-facing text. */
export function stripRefinerySignals(text: string): string {
  return text.replace(SIGNAL_RE, "").replace(DANGLING_SIGNAL_RE, "").trim();
}

const SIGNAL_OPEN = "%%ACTIONS%%";
function partialMarkerHoldback(s: string, marker: string): number {
  const max = Math.min(s.length, marker.length - 1);
  for (let n = max; n > 0; n--) {
    if (s.slice(s.length - n) === marker.slice(0, n)) return n;
  }
  return 0;
}
/**
 * Incremental signal stripper for streaming: feed raw model deltas, get back
 * only text safe to display (never a partial or whole %%ACTIONS%% block).
 */
export function createStreamingSignalStripper() {
  let buf = "";
  return {
    push(raw: string): string {
      buf += raw;
      buf = buf.replace(/%%ACTIONS%%[\s\S]*?%%\/ACTIONS%%/g, "");
      const open = buf.indexOf(SIGNAL_OPEN);
      if (open !== -1) {
        const safe = buf.slice(0, open);
        buf = buf.slice(open);
        return safe;
      }
      const hold = partialMarkerHoldback(buf, SIGNAL_OPEN);
      const safe = hold ? buf.slice(0, buf.length - hold) : buf;
      buf = hold ? buf.slice(buf.length - hold) : "";
      return safe;
    },
    flush(): string {
      const out = buf.replace(/%%ACTIONS%%[\s\S]*$/, "");
      buf = "";
      return out;
    },
  };
}
