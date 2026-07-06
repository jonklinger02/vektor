import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import {
  ArchiveRestore,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  FlaskConical,
  Pencil,
  Plus,
} from "lucide-react";
import type { RefinerySession } from "@paperclipai/shared";
import { refineryApi } from "../api/refinery";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { RefineryChatPane } from "../components/RefineryChatPane";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "../lib/utils";

// Refinery: a private, un-company-scoped workspace where a user chats with a
// model to shape an idea before "finalizing" it into a task/goal/project.
// This page owns the sessions sidebar (list, create, rename, archive) and a
// selection state; the chat pane itself is RefineryChatPane (Task 10).

const FINALIZED_LINK: Record<string, (session: RefinerySession) => string | null> = {
  task: (s) => (s.finalizedEntityId ? `/issues/${s.finalizedEntityId}` : null),
  project: (s) => (s.finalizedEntityId ? `/projects/${s.finalizedEntityId}` : null),
  goal: () => "/goals",
};

function finalizedLinkFor(session: RefinerySession): string | null {
  if (!session.finalizedKind) return null;
  const build = FINALIZED_LINK[session.finalizedKind];
  return build ? build(session) : null;
}

function SessionRow({
  session,
  selected,
  onSelect,
  onRename,
  onArchive,
  onRestore,
}: {
  session: RefinerySession;
  selected: boolean;
  onSelect: () => void;
  onRename: (title: string) => void;
  onArchive: () => void;
  onRestore: () => void;
  }) {
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(session.title);
  const archived = session.status === "archived";
  const finalizedHref = finalizedLinkFor(session);

  function commitRename() {
    const trimmed = draftTitle.trim();
    setEditing(false);
    if (trimmed && trimmed !== session.title) {
      onRename(trimmed);
    } else {
      setDraftTitle(session.title);
    }
  }

  if (editing) {
    return (
      <li className="px-2 py-1">
        <Input
          autoFocus
          value={draftTitle}
          aria-label="Session title"
          onChange={(e) => setDraftTitle(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") {
              setDraftTitle(session.title);
              setEditing(false);
            }
          }}
          className="h-8 text-sm"
        />
      </li>
    );
  }

  return (
    <li data-testid={`refinery-session-row-${session.id}`}>
      <div
        className={cn(
          "group flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm",
          selected ? "bg-accent text-foreground" : "hover:bg-accent/50 text-foreground/80",
        )}
      >
        <button
          type="button"
          onClick={onSelect}
          className="min-w-0 flex-1 truncate text-left"
        >
          {session.title}
        </button>
        {finalizedHref && (
          <Link
            to={finalizedHref}
            data-testid={`refinery-finalized-chip-${session.id}`}
            className="shrink-0 inline-flex items-center gap-0.5 rounded-full border border-border px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:text-foreground"
          >
            {session.finalizedKind}
            <ArrowRight className="h-2.5 w-2.5" />
          </Link>
        )}
        <button
          type="button"
          aria-label="Rename session"
          title="Rename"
          onClick={() => {
            setDraftTitle(session.title);
            setEditing(true);
          }}
          className="shrink-0 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label={archived ? "Restore session" : "Archive session"}
          title={archived ? "Restore" : "Archive"}
          onClick={archived ? onRestore : onArchive}
          className="shrink-0 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground"
        >
          <ArchiveRestore className="h-3.5 w-3.5" />
        </button>
      </div>
    </li>
  );
}

export function Refinery() {
  const queryClient = useQueryClient();
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const { data: sessions, isLoading } = useQuery({
    queryKey: queryKeys.refinery.sessions(),
    queryFn: () => refineryApi.listSessions(),
  });

  const invalidateSessions = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.refinery.sessions() });

  const createMutation = useMutation({
    mutationFn: () => refineryApi.createSession(),
    onSuccess: async (created) => {
      await invalidateSessions();
      setSelectedSessionId(created.id);
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: { title?: string; status?: string } }) =>
      refineryApi.updateSession(id, data),
    onSuccess: () => invalidateSessions(),
  });

  const { activeSessions, archivedSessions } = useMemo(() => {
    const all = sessions ?? [];
    return {
      activeSessions: all.filter((s) => s.status !== "archived"),
      archivedSessions: all.filter((s) => s.status === "archived"),
    };
  }, [sessions]);

  return (
    <div className="flex h-screen min-h-0 w-full">
      <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-background">
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-3">
          <div className="flex items-center gap-1.5 text-sm font-semibold">
            <FlaskConical className="h-4 w-4" />
            Refinery
          </div>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="New session"
            title="New session"
            onClick={() => createMutation.mutate()}
            disabled={createMutation.isPending}
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {isLoading ? (
            <p className="px-2 py-1 text-xs text-muted-foreground">Loading sessions…</p>
          ) : activeSessions.length === 0 ? (
            <EmptyState
              icon={FlaskConical}
              message="No sessions yet."
              action="New session"
              onAction={() => createMutation.mutate()}
            />
          ) : (
            <ul className="space-y-0.5">
              {activeSessions.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  selected={session.id === selectedSessionId}
                  onSelect={() => setSelectedSessionId(session.id)}
                  onRename={(title) => updateMutation.mutate({ id: session.id, data: { title } })}
                  onArchive={() =>
                    updateMutation.mutate({ id: session.id, data: { status: "archived" } })
                  }
                  onRestore={() =>
                    updateMutation.mutate({ id: session.id, data: { status: "active" } })
                  }
                />
              ))}
            </ul>
          )}

          {archivedSessions.length > 0 && (
            <div className="mt-3">
              <button
                type="button"
                onClick={() => setShowArchived((v) => !v)}
                className="flex w-full items-center gap-1 px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                {showArchived ? (
                  <ChevronDown className="h-3 w-3" />
                ) : (
                  <ChevronRight className="h-3 w-3" />
                )}
                Archived · {archivedSessions.length}
              </button>
              {showArchived && (
                <ul className="space-y-0.5">
                  {archivedSessions.map((session) => (
                    <SessionRow
                      key={session.id}
                      session={session}
                      selected={session.id === selectedSessionId}
                      onSelect={() => setSelectedSessionId(session.id)}
                      onRename={(title) => updateMutation.mutate({ id: session.id, data: { title } })}
                      onArchive={() =>
                        updateMutation.mutate({ id: session.id, data: { status: "archived" } })
                      }
                      onRestore={() =>
                        updateMutation.mutate({ id: session.id, data: { status: "active" } })
                      }
                    />
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </aside>

      <main className="min-h-0 flex-1">
        {selectedSessionId ? (
          <RefineryChatPane sessionId={selectedSessionId} />
        ) : (
          <div className="flex h-full items-center justify-center">
            <EmptyState
              icon={FlaskConical}
              message="Select a session or start a new one to begin refining."
              action="New session"
              onAction={() => createMutation.mutate()}
            />
          </div>
        )}
      </main>
    </div>
  );
}
