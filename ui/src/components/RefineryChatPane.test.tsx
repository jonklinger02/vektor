// @vitest-environment jsdom

import { act, forwardRef, useImperativeHandle } from "react";
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RefineryChatPane } from "./RefineryChatPane";

/**
 * Task 10 coverage: SSE streaming into the transcript (with defensive signal
 * stripping), model-choice persistence to localStorage, and visible surfacing
 * of relay `error` events. Radix `Select` is swapped for a native `<select>`
 * here (same pattern BoardChat.test.tsx uses for Sheet/Tooltip) so the test
 * exercises our component logic without fighting jsdom's lack of Pointer
 * Events support.
 */

const refineryApiMock = vi.hoisted(() => ({
  listSessions: vi.fn(),
  listMessages: vi.fn(),
  listModels: vi.fn(),
  toggleContext: vi.fn(),
}));

vi.mock("../api/refinery", () => ({ refineryApi: refineryApiMock }));

vi.mock("../components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("../components/ChatComposer", () => ({
  ChatComposer: forwardRef(function MockChatComposer(
    props: {
      value: string;
      onChange: (v: string) => void;
      onSubmit: () => void;
      submitting?: boolean;
      disabled?: boolean;
    },
    ref: React.Ref<{ focus: () => void }>,
  ) {
    useImperativeHandle(ref, () => ({ focus: vi.fn() }));
    return (
      <div data-testid="chat-composer">
        <textarea
          data-testid="chat-composer-input"
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
        />
        <button
          type="button"
          data-testid="chat-composer-send"
          disabled={props.disabled || props.submitting}
          onClick={() => props.onSubmit()}
        >
          Send
        </button>
      </div>
    );
  }),
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value?: string;
    onValueChange: (v: string) => void;
    children: ReactNode;
  }) => (
    <select
      data-testid="refinery-model-select"
      value={value ?? ""}
      onChange={(e) => onValueChange(e.target.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function sseStream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(`data: ${line}\n\n`));
      }
      controller.close();
    },
  });
}

function mockFetchResponse(lines: string[]): Response {
  return {
    ok: true,
    body: sseStream(lines),
  } as unknown as Response;
}

/**
 * A stream that enqueues its lines but never closes — used to assert on
 * mid-stream display (e.g. the defensive `stripRefinerySignals` pass) without
 * racing the `done`-triggered cleanup that clears `streamingText` once the
 * reader loop naturally exits.
 */
function mockOpenFetchResponse(lines: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(`data: ${line}\n\n`));
      }
      // deliberately never closed
    },
  });
  return { ok: true, body } as unknown as Response;
}

async function flush() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitForAssertion(assertion: () => void, attempts = 50) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flush();
    }
  }
  throw lastError;
}

function renderPane(container: HTMLDivElement, sessionId = "session-1") {
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  flushSync(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <RefineryChatPane sessionId={sessionId} />
      </QueryClientProvider>,
    );
  });
  return { root, queryClient };
}

describe("RefineryChatPane", () => {
  let container: HTMLDivElement;
  let unmounts: Root[] = [];

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    unmounts = [];
    localStorage.clear();

    refineryApiMock.listSessions.mockReset().mockResolvedValue([
      { id: "session-1", ownerUserId: "u1", title: "My idea", status: "active", model: null, finalizedKind: null, finalizedEntityId: null, finalizedCompanyId: null, createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z" },
    ]);
    refineryApiMock.listMessages.mockReset().mockResolvedValue([]);
    refineryApiMock.listModels.mockReset().mockResolvedValue([
      { id: "model-a", label: "Model A", tier: "standard" },
      { id: "model-b", label: "Model B", tier: "frontier" },
    ]);
    refineryApiMock.toggleContext.mockReset().mockResolvedValue({});

    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    for (const root of unmounts) {
      flushSync(() => root.unmount());
    }
    container.remove();
    vi.unstubAllGlobals();
  });

  it("streams chunks into the transcript and strips %%ACTIONS%% signals", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(
      mockOpenFetchResponse([
        JSON.stringify({ type: "status", text: "Thinking..." }),
        JSON.stringify({ type: "chunk", text: "Hello " }),
        JSON.stringify({ type: "chunk", text: "world%%ACTIONS%%{\"proposal\":null}%%/ACTIONS%%" }),
      ]),
    );

    const { root } = renderPane(container);
    unmounts.push(root);

    await waitForAssertion(() => {
      expect(container.querySelector('[data-testid="refinery-model-select"]')).not.toBeNull();
    });

    const textarea = container.querySelector('[data-testid="chat-composer-input"]') as HTMLTextAreaElement;
    flushSync(() => {
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      nativeSetter.call(textarea, "Refine this idea");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      textarea.dispatchEvent(new Event("change", { bubbles: true }));
    });

    // The mock composer's onChange wires straight to setInput; assert it took.
    await waitForAssertion(() => {
      expect((container.querySelector('[data-testid="chat-composer-input"]') as HTMLTextAreaElement).value).toBe(
        "Refine this idea",
      );
    });

    await waitForAssertion(() => {
      const sendButton = container.querySelector('[data-testid="chat-composer-send"]') as HTMLButtonElement;
      expect(sendButton.disabled).toBe(false);
    });

    const sendButton = container.querySelector('[data-testid="chat-composer-send"]') as HTMLButtonElement;
    await act(async () => {
      sendButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flush();
    });

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Hello world");
    });

    expect(container.textContent).not.toContain("%%ACTIONS%%");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/refinery/sessions/session-1/chat/stream",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ message: "Refine this idea", model: "model-a" }),
      }),
    );
  });

  it("persists model choice to localStorage", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse([])));

    const { root } = renderPane(container);
    unmounts.push(root);

    await waitForAssertion(() => {
      expect(container.querySelector('[data-testid="refinery-model-select"]')).not.toBeNull();
    });

    // No stored choice yet — the component falls back to the first model
    // (reflected in the select's value) without writing to storage until the
    // user actually changes it.
    await waitForAssertion(() => {
      const select = container.querySelector('[data-testid="refinery-model-select"]') as HTMLSelectElement;
      expect(select.value).toBe("model-a");
    });
    expect(localStorage.getItem("paperclip.refineryModel")).toBeNull();

    const select = container.querySelector('[data-testid="refinery-model-select"]') as HTMLSelectElement;
    flushSync(() => {
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
      nativeSetter.call(select, "model-b");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await waitForAssertion(() => {
      expect(localStorage.getItem("paperclip.refineryModel")).toBe("model-b");
    });
  });

  it("surfaces relay errors from an error event", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(
      mockFetchResponse([JSON.stringify({ type: "error", message: "The model relay timed out." })]),
    );

    const { root } = renderPane(container);
    unmounts.push(root);

    await waitForAssertion(() => {
      expect(container.querySelector('[data-testid="refinery-model-select"]')).not.toBeNull();
    });

    const textarea = container.querySelector('[data-testid="chat-composer-input"]') as HTMLTextAreaElement;
    flushSync(() => {
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      nativeSetter.call(textarea, "Will this fail?");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await waitForAssertion(() => {
      const sendButton = container.querySelector('[data-testid="chat-composer-send"]') as HTMLButtonElement;
      expect(sendButton.disabled).toBe(false);
    });

    const sendButton = container.querySelector('[data-testid="chat-composer-send"]') as HTMLButtonElement;
    await act(async () => {
      sendButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flush();
    });

    await waitForAssertion(() => {
      const alert = container.querySelector('[role="alert"]');
      expect(alert).not.toBeNull();
      expect(alert?.textContent).toContain("The model relay timed out.");
    });
  });

  it("aborts the in-flight stream request when the sessionId changes, so a late event can never repaint the new session", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(
      mockOpenFetchResponse([JSON.stringify({ type: "chunk", text: "stale session-1 reply" })]),
    );

    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <RefineryChatPane sessionId="session-1" />
        </QueryClientProvider>,
      );
    });
    unmounts.push(root);

    await waitForAssertion(() => {
      expect(container.querySelector('[data-testid="refinery-model-select"]')).not.toBeNull();
    });

    const textarea = container.querySelector('[data-testid="chat-composer-input"]') as HTMLTextAreaElement;
    flushSync(() => {
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      nativeSetter.call(textarea, "Refine this idea");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await waitForAssertion(() => {
      const sendButton = container.querySelector('[data-testid="chat-composer-send"]') as HTMLButtonElement;
      expect(sendButton.disabled).toBe(false);
    });

    const sendButton = container.querySelector('[data-testid="chat-composer-send"]') as HTMLButtonElement;
    await act(async () => {
      sendButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flush();
    });

    await waitForAssertion(() => {
      expect(container.textContent).toContain("stale session-1 reply");
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const signal = requestInit.signal as AbortSignal;
    expect(signal.aborted).toBe(false);

    // Switch this same instance to a different session — mirrors the
    // defense-in-depth cleanup inside RefineryChatPane itself (the parent
    // page additionally remounts via `key={sessionId}`, which this render
    // path deliberately doesn't exercise, so the assertion below is about
    // the pane's own AbortController cleanup, not the remount).
    await act(async () => {
      flushSync(() => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <RefineryChatPane sessionId="session-2" />
          </QueryClientProvider>,
        );
      });
      await flush();
    });

    await waitForAssertion(() => {
      expect(signal.aborted).toBe(true);
    });

    // The old session's streamed text must not survive into the new
    // session's render (per-session state reset).
    await waitForAssertion(() => {
      expect(container.textContent).not.toContain("stale session-1 reply");
    });
  });

  it("keeps the optimistic user bubble visible with no gap until the refetched messages list contains it", async () => {
    let resolveRefetchedMessages: (value: unknown[]) => void = () => {};
    refineryApiMock.listMessages
      .mockReset()
      .mockResolvedValueOnce([]) // initial mount fetch
      .mockImplementationOnce(
        () => new Promise((resolve) => { resolveRefetchedMessages = resolve; }),
      ); // refetch triggered by the `done` event's invalidateQueries

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(mockFetchResponse([JSON.stringify({ type: "done", proposal: null })]));

    function countBubbles(text: string): number {
      return Array.from(container.querySelectorAll("div")).filter(
        (el) => el.children.length === 0 && el.textContent === text,
      ).length;
    }

    const { root } = renderPane(container);
    unmounts.push(root);

    await waitForAssertion(() => {
      expect(container.querySelector('[data-testid="refinery-model-select"]')).not.toBeNull();
    });

    const textarea = container.querySelector('[data-testid="chat-composer-input"]') as HTMLTextAreaElement;
    flushSync(() => {
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      nativeSetter.call(textarea, "New idea to refine");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await waitForAssertion(() => {
      const sendButton = container.querySelector('[data-testid="chat-composer-send"]') as HTMLButtonElement;
      expect(sendButton.disabled).toBe(false);
    });

    const sendButton = container.querySelector('[data-testid="chat-composer-send"]') as HTMLButtonElement;
    await act(async () => {
      sendButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flush();
    });

    // The stream has already completed (`done` fired, `sending` cleared) but
    // the refetch of the messages query hasn't resolved yet — the optimistic
    // bubble must still be the one and only rendering of this text. Clearing
    // it eagerly in `finally` (the bug this test guards against) would drop
    // this to zero here, producing a visible gap.
    await waitForAssertion(() => {
      expect(countBubbles("New idea to refine")).toBe(1);
    });

    // Now let the refetch resolve with the persisted, server-side message.
    resolveRefetchedMessages([
      {
        id: "m1",
        sessionId: "session-1",
        role: "user",
        body: "New idea to refine",
        model: null,
        contextExcluded: false,
        createdAt: "2026-07-01T00:00:01.000Z",
      },
    ]);

    // Settles back to exactly one bubble (the optimistic one handed off
    // cleanly to the persisted message) — never zero, never two.
    await waitForAssertion(() => {
      expect(countBubbles("New idea to refine")).toBe(1);
    });
  });
});
