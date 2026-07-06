import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import { useNavigate } from "@/lib/router";
import { issuesApi } from "@/api/issues";
import { agentsApi } from "@/api/agents";
import { queryKeys } from "@/lib/queryKeys";
import { createIssueDetailPath } from "@/lib/issueDetailBreadcrumb";
import { Button } from "@/components/ui/button";
import { KanbanBoard } from "@/components/KanbanBoard";
import { EisenhowerMatrix } from "./EisenhowerMatrix";
import { patchForQuadrantDrop, type Quadrant } from "./grouping";

type BoardMode = "kanban" | "eisenhower";
const VIEW_STORAGE_KEY = "paperclip:project-board-view";

function readInitialMode(): BoardMode {
  if (typeof window === "undefined") return "eisenhower";
  const stored = window.localStorage.getItem(VIEW_STORAGE_KEY);
  return stored === "kanban" || stored === "eisenhower" ? stored : "eisenhower";
}

export interface ProjectBoardViewProps {
  projectId: string;
  companyId: string;
}

export function ProjectBoardView({ projectId, companyId }: ProjectBoardViewProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [mode, setMode] = useState<BoardMode>(readInitialMode);

  const listKey = queryKeys.issues.listByProject(companyId, projectId);

  const { data: issues, isLoading, error } = useQuery({
    queryKey: listKey,
    queryFn: () => issuesApi.list(companyId, { projectId }),
    enabled: !!companyId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: !!companyId,
  });

  const agentNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of agents ?? []) map.set(a.id, a.name);
    return map;
  }, [agents]);

  const assigneeNameFor = (issue: Issue): string | null =>
    (issue.assigneeAgentId && agentNameById.get(issue.assigneeAgentId)) || issue.assigneeUserId || null;

  const updateIssue = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) => issuesApi.update(id, data),
    onMutate: async ({ id, data }) => {
      await queryClient.cancelQueries({ queryKey: listKey });
      const previous = queryClient.getQueryData<Issue[]>(listKey);
      queryClient.setQueryData<Issue[]>(listKey, (old) =>
        old?.map((issue) => (issue.id === id ? { ...issue, ...data } : issue)),
      );
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(listKey, context.previous);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: listKey });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
    },
  });

  const applyUpdate = (id: string, data: Record<string, unknown>) => updateIssue.mutate({ id, data });

  const changeMode = (next: BoardMode) => {
    setMode(next);
    if (typeof window !== "undefined") window.localStorage.setItem(VIEW_STORAGE_KEY, next);
  };

  const openIssue = (issue: Issue) => navigate(createIssueDetailPath(issue.identifier ?? issue.id));
  const allIssues = issues ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 py-3">
      <div className="flex items-center gap-1 self-start rounded-md border border-border bg-muted/40 p-0.5">
        <Button size="sm" variant={mode === "eisenhower" ? "default" : "ghost"} onClick={() => changeMode("eisenhower")}>
          Eisenhower
        </Button>
        <Button size="sm" variant={mode === "kanban" ? "default" : "ghost"} onClick={() => changeMode("kanban")}>
          Kanban
        </Button>
      </div>

      {isLoading && <div className="text-sm text-muted-foreground">Loading tasks…</div>}
      {error && <div className="text-sm text-destructive">Failed to load tasks.</div>}

      {!isLoading && !error && mode === "kanban" && (
        <KanbanBoard issues={allIssues} agents={agents} onUpdateIssue={applyUpdate} />
      )}

      {!isLoading && !error && mode === "eisenhower" && (
        <EisenhowerMatrix
          issues={allIssues}
          assigneeName={assigneeNameFor}
          onOpenIssue={openIssue}
          onDropQuadrant={(issue, quadrant: Quadrant) => applyUpdate(issue.id, patchForQuadrantDrop(quadrant, issue))}
          onDropUnsorted={(issue) => {
            if (issue.importance != null) applyUpdate(issue.id, { importance: null });
          }}
        />
      )}
    </div>
  );
}
