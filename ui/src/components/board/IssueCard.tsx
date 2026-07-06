import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import type { Issue } from "@paperclipai/shared";
import { cn } from "@/lib/utils";
import { StatusIcon } from "@/components/StatusIcon";
import { PriorityIcon } from "@/components/PriorityIcon";

export interface IssueCardProps {
  issue: Issue;
  /** Resolved assignee display name, if the parent could resolve one. */
  assigneeName?: string | null;
  /** Whether to show the status glyph (hide it on the Kanban board where the column implies status). */
  showStatus?: boolean;
  onOpen?: (issue: Issue) => void;
}

export function IssueCard({ issue, assigneeName, showStatus = true, onOpen }: IssueCardProps) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: issue.id });

  const style = transform
    ? { transform: CSS.Translate.toString(transform) }
    : undefined;

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={() => onOpen?.(issue)}
      className={cn(
        "group cursor-grab select-none rounded-md border border-border bg-card p-2.5 text-left shadow-sm",
        "hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        isDragging && "opacity-50",
      )}
    >
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {showStatus && <StatusIcon status={issue.status} size="sm" />}
        <PriorityIcon priority={issue.priority} />
        {issue.identifier && <span className="font-mono">{issue.identifier}</span>}
      </div>
      <div className="mt-1 line-clamp-3 text-sm font-medium text-foreground">{issue.title}</div>
      {assigneeName && (
        <div className="mt-1.5 truncate text-xs text-muted-foreground">{assigneeName}</div>
      )}
    </div>
  );
}
