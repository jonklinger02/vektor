import type { Issue, IssuePriority, IssueImportance, IssueStatus } from "@paperclipai/shared";

export type Quadrant = "do" | "schedule" | "delegate" | "eliminate";
export type KanbanStatus = "backlog" | "todo" | "in_progress" | "in_review" | "blocked" | "done";

export const KANBAN_STATUSES: readonly KanbanStatus[] = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
];
export const QUADRANTS: readonly Quadrant[] = ["do", "schedule", "delegate", "eliminate"];

const URGENT: ReadonlySet<IssuePriority> = new Set<IssuePriority>(["critical", "high"]);

export function isUrgent(priority: IssuePriority): boolean {
  return URGENT.has(priority);
}

export function quadrantOf(priority: IssuePriority, importance: IssueImportance | null): Quadrant | null {
  if (importance == null) return null;
  const urgent = isUrgent(priority);
  if (importance === "important") return urgent ? "do" : "schedule";
  return urgent ? "delegate" : "eliminate";
}

export function groupByStatus(issues: Issue[]): Record<KanbanStatus, Issue[]> {
  const out = Object.fromEntries(KANBAN_STATUSES.map((s) => [s, [] as Issue[]])) as Record<KanbanStatus, Issue[]>;
  for (const issue of issues) {
    if ((KANBAN_STATUSES as readonly string[]).includes(issue.status)) {
      out[issue.status as KanbanStatus].push(issue);
    }
  }
  return out;
}

export function groupByQuadrant(issues: Issue[]): { quadrant: Record<Quadrant, Issue[]>; unsorted: Issue[] } {
  const quadrant = Object.fromEntries(QUADRANTS.map((q) => [q, [] as Issue[]])) as Record<Quadrant, Issue[]>;
  const unsorted: Issue[] = [];
  for (const issue of issues) {
    const q = quadrantOf(issue.priority, issue.importance);
    if (q) quadrant[q].push(issue);
    else unsorted.push(issue);
  }
  return { quadrant, unsorted };
}

export function patchForStatusDrop(status: KanbanStatus): { status: IssueStatus } {
  return { status };
}

const QUAD_META: Record<Quadrant, { urgent: boolean; importance: IssueImportance }> = {
  do: { urgent: true, importance: "important" },
  schedule: { urgent: false, importance: "important" },
  delegate: { urgent: true, importance: "not_important" },
  eliminate: { urgent: false, importance: "not_important" },
};

export function patchForQuadrantDrop(
  q: Quadrant,
  issue: Issue,
): { importance: IssueImportance; priority?: IssuePriority } {
  const meta = QUAD_META[q];
  const patch: { importance: IssueImportance; priority?: IssuePriority } = { importance: meta.importance };
  const currentlyUrgent = isUrgent(issue.priority);
  if (meta.urgent && !currentlyUrgent) patch.priority = "high"; // cross into urgent band
  if (!meta.urgent && currentlyUrgent) patch.priority = "medium"; // cross into not-urgent band
  return patch;
}
