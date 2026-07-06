import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { EyeOff, Eye, FlaskConical, MoreHorizontal, ScanEye } from "lucide-react";
import type { RefineryMessage, RefineryProposal } from "@paperclipai/shared";
import { stripRefinerySignals } from "@paperclipai/shared";
import { refineryApi } from "../api/refinery";
import { queryKeys } from "../lib/queryKeys";
import { MarkdownBody } from "./MarkdownBody";
import { ChatComposer, type ChatComposerHandle } from "./ChatComposer";
import { RefineryContextDrawer } from "./RefineryContextDrawer";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { cn } from "../lib/utils";

/**
 * Refinery chat pane (Task 10, extended in Task 11) — a private,
 * un-company-scoped chat where the user shapes an idea with a model before
 * "finalizing" it into a task/goal/project. Mirrors BoardChat's SSE streaming
 * plumbing (fetch + ReadableStream reader loop) against the refinery-specific
 * endpoint, plus a model picker persisted to localStorage. The `proposal`
 * produced by a `done` event is kept in state for Task 12 to render as a
 * card.
 *
 * Task 11 (context filter): Task 10 already wired the per-message
 * `onToggleContext` mutation and an eye/eye-off icon button per bubble. This
 * pass adds (a) dimmed/struck-through styling on excluded bubbles so
 * exclusion is visible without hiding the message, (b) a per-bubble "exclude
 * from here up/down" range action (bulk `toggleContext` calls over the
 * currently-included slice), and (c) a header "inspect context" button that
 * opens `RefineryContextDrawer`, which lists exactly the messages the server
 * will send next (`!contextExcluded`) — the same predicate the pane and the
 * server's `buildHistory` both use, so drawer contents and the next request
 * body always agree by construction.
 */

const REFINERY_BUBBLE_SHELL =
  "min-w-0 max-w-[85%] break-words px-3 py-2 text-sm overflow-x-auto overflow-y-visible";

const REFINERY_MARKDOWN_CLASS =
  "max-w-full overflow-visible [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto";

const REFINERY_MODEL_STORAGE_KEY = "paperclip.refineryModel";

function readStoredModel(): string | null {
  try {
    return localStorage.getItem(REFINERY_MODEL_STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeModel(modelId: string): void {
  try {
    localStorage.setItem(REFINERY_MODEL_STORAGE_KEY, modelId);
  } catch {
    /* private mode / quota — persistence is best-effort */
  }
}

export interface RefineryChatPaneProps {
  sessionId: string;
}

export function RefineryChatPane({ sessionId }: RefineryChatPaneProps) {
  const queryClient = useQueryClient();
  const composerRef = useRef<ChatComposerHandle>(null);
  const controllerRef = useRef<AbortController | null>(null);

  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [optimisticMessage, setOptimisticMessage] = useState<string | null>(null);
  const [streamingText, setStreamingText] = useState("");
  const [statusText, setStatusText] = useState("");
  const [errorText, setErrorText] = useState("");
  const [proposal, setProposal] = useState<RefineryProposal | null>(null);
  const [selectedModel, setSelectedModel] = useState<string | null>(() => readStoredModel());
  const [contextDrawerOpen, setContextDrawerOpen] = useState(false);

  const { data: sessions } = useQuery({
    queryKey: queryKeys.refinery.sessions(),
    queryFn: () => refineryApi.listSessions(),
  });
  const currentSession = useMemo(
    () => sessions?.find((s) => s.id === sessionId) ?? null,
    [sessions, sessionId],
  );

  const { data: messages } = useQuery({
    queryKey: queryKeys.refinery.messages(sessionId),
    queryFn: () => refineryApi.listMessages(sessionId),
  });

  const { data: models } = useQuery({
    queryKey: queryKeys.refinery.models(),
    queryFn: () => refineryApi.listModels(),
  });

  // Fall back to the first available model when there's no stored choice, or
  // the stored choice no longer matches a known model.
  useEffect(() => {
    if (!models || models.length === 0) return;
    if (selectedModel && models.some((m) => m.id === selectedModel)) return;
    const fallback = models[0]?.id ?? null;
    if (fallback) setSelectedModel(fallback);
  }, [models, selectedModel]);

  function handleModelChange(next: string) {
    setSelectedModel(next);
    storeModel(next);
  }

  // Reset per-session transient state when switching sessions so a stale
  // streaming bubble / error from a previous session never leaks over.
  useEffect(() => {
    setInput("");
    setSending(false);
    setOptimisticMessage(null);
    setStreamingText("");
    setStatusText("");
    setErrorText("");
    setProposal(null);
  }, [sessionId]);

  // Defense in depth against a cross-session state leak: abort any in-flight
  // stream request when this pane unmounts or the sessionId it's bound to
  // changes, so a late chunk/done/error event from an old session's request
  // can never setState into a pane now showing a different session (the
  // parent also remounts this component via `key={sessionId}`, but that
  // alone doesn't stop the superseded fetch from running to completion).
  useEffect(() => {
    return () => {
      controllerRef.current?.abort();
    };
  }, [sessionId]);

  // Clear the optimistic user bubble only once the refetched, server-
  // persisted messages list actually contains it as the MOST RECENT user
  // message (mirrors BoardChat's pattern) — clearing eagerly in the send
  // `finally` causes the bubble to flash away before the refetch repopulates
  // it, leaving a visible gap. Matching against the whole list (rather than
  // just the last user message) false-positives when the sent text
  // duplicates an earlier message (e.g. "yes"/"continue" in an iterative
  // chat), clearing the bubble early against the stale pre-refetch cache.
  useEffect(() => {
    if (!optimisticMessage) return;
    const list = messages ?? [];
    let lastUser: RefineryMessage | undefined;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].role === "user") {
        lastUser = list[i];
        break;
      }
    }
    if (lastUser?.body === optimisticMessage) {
      setOptimisticMessage(null);
    }
  }, [messages, optimisticMessage]);

  const toggleContextMutation = useMutation({
    mutationFn: ({ id, excluded }: { id: string; excluded: boolean }) =>
      refineryApi.toggleContext(id, excluded),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.refinery.messages(sessionId) }),
  });

  const onToggleContext = useCallback(
    (messageId: string, contextExcluded: boolean) => {
      toggleContextMutation.mutate({ id: messageId, excluded: !contextExcluded });
    },
    [toggleContextMutation],
  );

  // Range action ("exclude from here up/down"): bulk-toggles every currently
  // INCLUDED message in the affected slice. Mirrors the single-message
  // mutation's invalidate-on-settle pattern (no separate optimistic path) so
  // there's only one cache-update strategy for context toggling in this pane.
  const rangeExcludeMutation = useMutation({
    mutationFn: (ids: string[]) =>
      Promise.all(ids.map((id) => refineryApi.toggleContext(id, true))),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.refinery.messages(sessionId) }),
  });

  const excludeRange = useCallback(
    (messageId: string, direction: "up" | "down") => {
      const list = messages ?? [];
      const index = list.findIndex((m) => m.id === messageId);
      if (index === -1) return;
      const affected = direction === "up" ? list.slice(0, index + 1) : list.slice(index);
      const ids = affected.filter((m) => !m.contextExcluded).map((m) => m.id);
      if (ids.length === 0) return;
      rangeExcludeMutation.mutate(ids);
    },
    [messages, rangeExcludeMutation],
  );

  const sendMessage = useCallback(
    async (body: string) => {
      const trimmed = body.trim();
      if (!trimmed || sending || !selectedModel) return;

      // Show user message immediately
      setOptimisticMessage(trimmed);
      setSending(true);
      setInput("");
      setStreamingText("");
      setErrorText("");
      setStatusText("Connecting...");

      // Abort any still-running request from a prior send before starting a
      // new one — only one stream should ever be live for this pane.
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;

      try {
        const fetchTimeout = setTimeout(() => controller.abort(), 130000);
        const res = await fetch(`/api/refinery/sessions/${sessionId}/chat/stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: trimmed, model: selectedModel }),
          signal: controller.signal,
        });
        clearTimeout(fetchTimeout);

        if (!res.ok || !res.body) {
          throw new Error("Refinery chat stream not available");
        }

        setStatusText("Thinking...");

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let accumulated = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const event = JSON.parse(line.slice(6));
              if (event.type === "chunk" && event.text) {
                accumulated += event.text;
                setStreamingText(stripRefinerySignals(accumulated));
                setStatusText("");
              } else if (event.type === "status" && event.text) {
                setStatusText(event.text);
              } else if (event.type === "error") {
                setErrorText(
                  event.message ||
                    "The refinery assistant couldn't respond. Please try again.",
                );
                setStatusText("");
              } else if (event.type === "done") {
                setProposal(event.proposal ?? null);
                queryClient.invalidateQueries({
                  queryKey: queryKeys.refinery.messages(sessionId),
                });
                queryClient.invalidateQueries({ queryKey: queryKeys.refinery.sessions() });
              }
            } catch {
              /* malformed SSE line */
            }
          }
        }

        setStreamingText("");
        setStatusText("");
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return; // intentional abort — not a failure
        console.error("Refinery chat error:", err);
        setStatusText("");
        setErrorText(
          "The refinery assistant is unavailable right now. Please try again in a moment.",
        );
      } finally {
        if (controllerRef.current === controller) {
          controllerRef.current = null;
        }
        setSending(false);
        // Note: optimisticMessage is intentionally NOT cleared here — see the
        // effect above, which clears it once the refetched messages list
        // actually contains the persisted message (mirrors BoardChat).
        composerRef.current?.focus();
      }
    },
    [sending, selectedModel, sessionId, queryClient],
  );

  const handleSend = useCallback(() => {
    void sendMessage(input);
  }, [input, sendMessage]);

  return (
    <div data-testid="refinery-chat-pane" data-session-id={sessionId} className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-foreground">
          <FlaskConical className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{currentSession?.title ?? "Refinery session"}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Inspect context"
            title="Inspect the exact message context the model will receive"
            data-testid="refinery-inspect-context-button"
            onClick={() => setContextDrawerOpen(true)}
          >
            <ScanEye className="h-4 w-4" />
          </Button>
          <Select value={selectedModel ?? undefined} onValueChange={handleModelChange}>
            <SelectTrigger className="h-8 w-[220px] text-xs" data-testid="refinery-model-select">
              <SelectValue placeholder="Choose a model" />
            </SelectTrigger>
            <SelectContent>
              {(models ?? []).map((model) => (
                <SelectItem key={model.id} value={model.id}>
                  {model.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4" data-testid="refinery-message-list">
        <div className="mx-auto flex max-w-3xl flex-col gap-3">
          {(messages ?? []).map((message) => {
            const isUser = message.role === "user";
            // Excluded messages stay in the transcript (never hidden) but read
            // as visibly "struck out" — the same predicate the drawer and the
            // server's buildHistory use is `!contextExcluded`, so this dimming
            // is purely presentational and never touches `body`.
            const excludedBubbleClass = message.contextExcluded && "opacity-50 line-through decoration-1";
            return (
              <div
                key={message.id}
                data-testid="refinery-message-row"
                data-context-excluded={message.contextExcluded}
                className={cn("group flex items-start gap-1.5", isUser ? "justify-end" : "justify-start")}
              >
                {!isUser && (
                  <div
                    className={cn(
                      REFINERY_BUBBLE_SHELL,
                      "bg-card border border-border text-foreground [border-radius:14px_14px_14px_4px]",
                      excludedBubbleClass,
                    )}
                  >
                    <MarkdownBody className={REFINERY_MARKDOWN_CLASS}>{message.body ?? ""}</MarkdownBody>
                  </div>
                )}
                {isUser && (
                  <div
                    className={cn(
                      REFINERY_BUBBLE_SHELL,
                      "bg-blue-600 text-white [border-radius:14px_14px_4px_14px]",
                      excludedBubbleClass,
                    )}
                  >
                    {message.body ?? ""}
                  </div>
                )}
                <div className="mt-2 flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
                  <button
                    type="button"
                    aria-label={message.contextExcluded ? "Include in context" : "Exclude from context"}
                    title={message.contextExcluded ? "Include in context" : "Exclude from context"}
                    onClick={() => onToggleContext(message.id, message.contextExcluded)}
                    className={cn(
                      "text-muted-foreground hover:text-foreground",
                      message.contextExcluded && "opacity-100 text-amber-600 dark:text-amber-400",
                    )}
                  >
                    {message.contextExcluded ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        aria-label="More context actions"
                        title="More context actions"
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <MoreHorizontal className="h-3.5 w-3.5" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align={isUser ? "end" : "start"}>
                      <DropdownMenuItem onSelect={() => excludeRange(message.id, "up")}>
                        Exclude from here up
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => excludeRange(message.id, "down")}>
                        Exclude from here down
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            );
          })}

          {optimisticMessage && (
            <div className="flex justify-end">
              <div
                className={cn(
                  REFINERY_BUBBLE_SHELL,
                  "bg-blue-600 text-white [border-radius:14px_14px_4px_14px]",
                )}
              >
                {optimisticMessage}
              </div>
            </div>
          )}

          {streamingText && (
            <div className="flex justify-start">
              <div
                className={cn(
                  REFINERY_BUBBLE_SHELL,
                  "bg-card border border-border text-foreground [border-radius:14px_14px_14px_4px]",
                )}
              >
                <MarkdownBody className={REFINERY_MARKDOWN_CLASS}>{streamingText}</MarkdownBody>
              </div>
            </div>
          )}

          {sending && (
            <div className="flex items-center gap-2 pl-1 text-xs text-muted-foreground">
              <span>{statusText || "Thinking..."}</span>
            </div>
          )}

          {errorText && !sending && (
            <div role="alert" className="flex justify-start">
              <div
                className={cn(
                  REFINERY_BUBBLE_SHELL,
                  "bg-destructive/10 border border-destructive/30 text-destructive [border-radius:14px_14px_14px_4px]",
                )}
              >
                {errorText}
              </div>
            </div>
          )}

          {proposal && (
            <div
              data-testid="refinery-proposal-placeholder"
              className="rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground"
            >
              Proposal ready: {proposal.title} ({proposal.kind})
            </div>
          )}
        </div>
      </div>

      <div className="shrink-0 border-t border-border px-4 py-3">
        <ChatComposer
          ref={composerRef}
          value={input}
          onChange={setInput}
          onSubmit={handleSend}
          placeholder="Describe the idea you want to refine..."
          submitKey="enter"
          submitting={sending}
          disabled={sending || !selectedModel}
          sendLabel="Send message"
        />
      </div>

      <RefineryContextDrawer
        open={contextDrawerOpen}
        onOpenChange={setContextDrawerOpen}
        messages={messages ?? []}
      />
    </div>
  );
}
