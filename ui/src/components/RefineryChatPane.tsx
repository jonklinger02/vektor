import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { EyeOff, Eye, FlaskConical } from "lucide-react";
import type { RefineryProposal } from "@paperclipai/shared";
import { stripRefinerySignals } from "@paperclipai/shared";
import { refineryApi } from "../api/refinery";
import { queryKeys } from "../lib/queryKeys";
import { MarkdownBody } from "./MarkdownBody";
import { ChatComposer, type ChatComposerHandle } from "./ChatComposer";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "../lib/utils";

/**
 * Refinery chat pane (Task 10) — a private, un-company-scoped chat where the
 * user shapes an idea with a model before "finalizing" it into a task/goal/
 * project. Mirrors BoardChat's SSE streaming plumbing (fetch + ReadableStream
 * reader loop) against the refinery-specific endpoint, plus a model picker
 * persisted to localStorage. The `proposal` produced by a `done` event is
 * kept in state for Task 12 to render as a card; Task 11 wires the per-message
 * `onToggleContext` affordance rendered here.
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

  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [optimisticMessage, setOptimisticMessage] = useState<string | null>(null);
  const [streamingText, setStreamingText] = useState("");
  const [statusText, setStatusText] = useState("");
  const [errorText, setErrorText] = useState("");
  const [proposal, setProposal] = useState<RefineryProposal | null>(null);
  const [selectedModel, setSelectedModel] = useState<string | null>(() => readStoredModel());

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

      try {
        const controller = new AbortController();
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
        console.error("Refinery chat error:", err);
        setStatusText("");
        setErrorText(
          "The refinery assistant is unavailable right now. Please try again in a moment.",
        );
      } finally {
        setSending(false);
        setOptimisticMessage(null);
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

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4" data-testid="refinery-message-list">
        <div className="mx-auto flex max-w-3xl flex-col gap-3">
          {(messages ?? []).map((message) => {
            const isUser = message.role === "user";
            return (
              <div
                key={message.id}
                className={cn("group flex items-start gap-1.5", isUser ? "justify-end" : "justify-start")}
              >
                {!isUser && (
                  <div
                    className={cn(
                      REFINERY_BUBBLE_SHELL,
                      "bg-card border border-border text-foreground [border-radius:14px_14px_14px_4px]",
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
                    )}
                  >
                    {message.body ?? ""}
                  </div>
                )}
                <button
                  type="button"
                  aria-label={message.contextExcluded ? "Include in context" : "Exclude from context"}
                  title={message.contextExcluded ? "Include in context" : "Exclude from context"}
                  onClick={() => onToggleContext(message.id, message.contextExcluded)}
                  className={cn(
                    "mt-2 shrink-0 opacity-0 transition-opacity duration-150 group-hover:opacity-100 text-muted-foreground hover:text-foreground",
                    message.contextExcluded && "opacity-100 text-amber-600 dark:text-amber-400",
                  )}
                >
                  {message.contextExcluded ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </button>
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
    </div>
  );
}
