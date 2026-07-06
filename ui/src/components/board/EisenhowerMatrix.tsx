import { useMemo } from "react";
import { DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import type { Issue } from "@paperclipai/shared";
import { cn } from "@/lib/utils";
import { BoardColumn } from "./BoardColumn";
import { IssueCard } from "./IssueCard";
import { QUADRANTS, groupByQuadrant, type Quadrant } from "./grouping";

const UNSORTED_ID = "unsorted";

const QUADRANT_META: Record<Quadrant, { title: string; subtitle: string; accent: string }> = {
  do: { title: "Do Now", subtitle: "Urgent · Important", accent: "#ef4444" },
  schedule: { title: "Schedule", subtitle: "Not urgent · Important", accent: "#6366f1" },
  delegate: { title: "Delegate", subtitle: "Urgent · Not important", accent: "#f59e0b" },
  eliminate: { title: "Eliminate", subtitle: "Not urgent · Not important", accent: "#6b7280" },
};

export interface EisenhowerMatrixProps {
  issues: Issue[];
  /** Called when an issue is dropped into a quadrant. */
  onDropQuadrant: (issue: Issue, quadrant: Quadrant) => void;
  /** Called when an issue is dropped into the Unsorted strip. */
  onDropUnsorted: (issue: Issue) => void;
  onOpenIssue?: (issue: Issue) => void;
  /** Resolve an assignee display name for a card. */
  assigneeName?: (issue: Issue) => string | null;
}

export function EisenhowerMatrix({
  issues,
  onDropQuadrant,
  onDropUnsorted,
  onOpenIssue,
  assigneeName,
}: EisenhowerMatrixProps) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const grouped = useMemo(() => groupByQuadrant(issues), [issues]);

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over) return;
    const issue = issues.find((i) => i.id === active.id);
    if (!issue) return;
    const overId = String(over.id);
    if (overId === UNSORTED_ID) {
      onDropUnsorted(issue);
      return;
    }
    if ((QUADRANTS as readonly string[]).includes(overId)) {
      onDropQuadrant(issue, overId as Quadrant);
    }
  };

  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 md:grid-cols-2">
        {QUADRANTS.map((q) => {
          const meta = QUADRANT_META[q];
          return (
            <BoardColumn
              key={q}
              id={q}
              title={meta.title}
              subtitle={meta.subtitle}
              accent={meta.accent}
              count={grouped.quadrant[q].length}
              className="min-h-[220px]"
            >
              {grouped.quadrant[q].map((issue) => (
                <IssueCard
                  key={issue.id}
                  issue={issue}
                  assigneeName={assigneeName?.(issue)}
                  onOpen={onOpenIssue}
                />
              ))}
            </BoardColumn>
          );
        })}
      </div>
      <BoardColumn
        id={UNSORTED_ID}
        title="Unsorted"
        subtitle="No importance set — drag into a quadrant"
        count={grouped.unsorted.length}
        className={cn("mt-3 max-h-64")}
      >
        <div className="flex flex-wrap gap-2">
          {grouped.unsorted.map((issue) => (
            <div key={issue.id} className="w-64">
              <IssueCard issue={issue} assigneeName={assigneeName?.(issue)} onOpen={onOpenIssue} />
            </div>
          ))}
        </div>
      </BoardColumn>
    </DndContext>
  );
}
