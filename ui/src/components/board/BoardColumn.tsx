import type { ReactNode } from "react";
import { useDroppable } from "@dnd-kit/core";
import { cn } from "@/lib/utils";

export interface BoardColumnProps {
  /** Droppable id — a KanbanStatus, a Quadrant, or "unsorted". */
  id: string;
  title: string;
  count: number;
  /** Optional accent color (CSS color) for the header dot / quadrant tint. */
  accent?: string;
  /** Optional secondary label under the title (e.g. the Eisenhower action). */
  subtitle?: string;
  className?: string;
  children: ReactNode;
}

export function BoardColumn({ id, title, count, accent, subtitle, className, children }: BoardColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id });

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex min-h-0 flex-col rounded-lg border border-border bg-muted/30 transition-colors",
        isOver && "border-primary bg-primary/5 ring-1 ring-primary",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          {accent && (
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: accent }} />
          )}
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-foreground">{title}</div>
            {subtitle && <div className="truncate text-xs text-muted-foreground">{subtitle}</div>}
          </div>
        </div>
        <span className="shrink-0 rounded-full bg-background px-2 py-0.5 text-xs text-muted-foreground">
          {count}
        </span>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto p-2">{children}</div>
    </div>
  );
}
