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

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onSelect,
  }: {
    children: ReactNode;
    onSelect?: () => void;
  }) => (
    <button type="button" onClick={onSelect}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div data-slot="sheet">{children}</div> : null,
  SheetContent: ({
    children,
    "data-testid": dataTestId,
  }: {
    children: ReactNode;
    side?: string;
    className?: string;
    "data-testid"?: string;
  }) => <div data-testid={dataTestId}>{children}</div>,
  SheetHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetDescription: ({ children }: { children: ReactNode }) => <div>{children}</div>,
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

  it("does not early-clear the optimistic bubble when the sent text duplicates an EARLIER (non-last) user message", async () => {
    // Session history already contains a prior "yes" from earlier in the
    // conversation, followed by a *different* most-recent user message
    // ("continue"). Sending "yes" again must not be false-matched against
    // that earlier duplicate while the refetch is still pending — only the
    // *last* user message should ever be compared against the optimistic
    // text.
    let resolveRefetchedMessages: (value: unknown[]) => void = () => {};
    refineryApiMock.listMessages
      .mockReset()
      .mockResolvedValueOnce([
        {
          id: "m0",
          sessionId: "session-1",
          role: "user",
          body: "yes",
          model: null,
          contextExcluded: false,
          createdAt: "2026-07-01T00:00:00.000Z",
        },
        {
          id: "m1",
          sessionId: "session-1",
          role: "user",
          body: "continue",
          model: null,
          contextExcluded: false,
          createdAt: "2026-07-01T00:00:01.000Z",
        },
      ]) // initial mount fetch — history already has "yes" earlier, "continue" last
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

    // Sanity: the earlier duplicate "yes" from history is already rendered.
    await waitForAssertion(() => {
      expect(countBubbles("yes")).toBe(1);
    });

    const textarea = container.querySelector('[data-testid="chat-composer-input"]') as HTMLTextAreaElement;
    flushSync(() => {
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      nativeSetter.call(textarea, "yes");
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

    // The stream has completed (`done` fired) but the refetch of the
    // messages query hasn't resolved yet. The list still only has the
    // EARLIER "yes" (m0) as a persisted message, not the new one — so the
    // optimistic bubble for the new send must still be showing, giving two
    // "yes" bubbles total (m0's persisted bubble + the optimistic one). The
    // whole-list-scan bug would false-match against m0 and clear the
    // optimistic bubble immediately, collapsing this to one.
    await waitForAssertion(() => {
      expect(countBubbles("yes")).toBe(2);
    });

    // Now let the refetch resolve with the persisted, server-side message —
    // the NEW "yes" lands as the last user message.
    resolveRefetchedMessages([
      {
        id: "m0",
        sessionId: "session-1",
        role: "user",
        body: "yes",
        model: null,
        contextExcluded: false,
        createdAt: "2026-07-01T00:00:00.000Z",
      },
      {
        id: "m1",
        sessionId: "session-1",
        role: "user",
        body: "continue",
        model: null,
        contextExcluded: false,
        createdAt: "2026-07-01T00:00:01.000Z",
      },
      {
        id: "m2",
        sessionId: "session-1",
        role: "user",
        body: "yes",
        model: null,
        contextExcluded: false,
        createdAt: "2026-07-01T00:00:02.000Z",
      },
    ]);

    // Settles to exactly two "yes" bubbles (m0 + the newly-persisted m2),
    // with the optimistic one correctly handed off — never three (which
    // would mean it never cleared), never one (which would mean it cleared
    // too early or the new message didn't render).
    await waitForAssertion(() => {
      expect(countBubbles("yes")).toBe(2);
    });
  });

  it("swallows an intentional AbortError silently — no error banner, no console.error", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockRejectedValue(new DOMException("The user aborted a request.", "AbortError"));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { root } = renderPane(container);
    unmounts.push(root);

    await waitForAssertion(() => {
      expect(container.querySelector('[data-testid="refinery-model-select"]')).not.toBeNull();
    });

    const textarea = container.querySelector('[data-testid="chat-composer-input"]') as HTMLTextAreaElement;
    flushSync(() => {
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      nativeSetter.call(textarea, "Aborted send");
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

    // `sending` still clears via `finally` even though the catch returned early.
    await waitForAssertion(() => {
      const sendButton2 = container.querySelector('[data-testid="chat-composer-send"]') as HTMLButtonElement;
      expect(sendButton2.disabled).toBe(false);
    });

    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(consoleErrorSpy).not.toHaveBeenCalledWith("Refinery chat error:", expect.anything());
    consoleErrorSpy.mockRestore();
  });

  it("toggles a message's exclusion, dims the bubble, and never touches body", async () => {
    refineryApiMock.listMessages
      .mockReset()
      .mockResolvedValueOnce([
        {
          id: "m1",
          sessionId: "session-1",
          role: "assistant",
          body: "Here is a suggestion.",
          model: "model-a",
          contextExcluded: false,
          createdAt: "2026-07-01T00:00:00.000Z",
        },
      ])
      // Refetch triggered by the toggle mutation's onSuccess invalidate.
      .mockResolvedValueOnce([
        {
          id: "m1",
          sessionId: "session-1",
          role: "assistant",
          body: "Here is a suggestion.",
          model: "model-a",
          contextExcluded: true,
          createdAt: "2026-07-01T00:00:00.000Z",
        },
      ]);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse([])));

    const { root } = renderPane(container);
    unmounts.push(root);

    await waitForAssertion(() => {
      expect(container.querySelector('[data-testid="refinery-message-row"]')).not.toBeNull();
    });

    const toggleButton = container.querySelector(
      'button[aria-label="Exclude from context"]',
    ) as HTMLButtonElement;
    expect(toggleButton).not.toBeNull();

    await act(async () => {
      toggleButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flush();
    });

    expect(refineryApiMock.toggleContext).toHaveBeenCalledWith("m1", true);

    await waitForAssertion(() => {
      const row = container.querySelector('[data-testid="refinery-message-row"]') as HTMLElement;
      expect(row.getAttribute("data-context-excluded")).toBe("true");
    });

    const row = container.querySelector('[data-testid="refinery-message-row"]') as HTMLElement;
    const dimmedBubble = row.querySelector(".opacity-50.line-through");
    expect(dimmedBubble).not.toBeNull();
    // Contract: toggling context NEVER alters `body` — the text is still
    // present verbatim, only its presentation changed.
    expect(dimmedBubble?.textContent).toContain("Here is a suggestion.");
  });

  it("drawer lists only included messages, in order, with a total char count", async () => {
    refineryApiMock.listMessages.mockReset().mockResolvedValue([
      {
        id: "m1",
        sessionId: "session-1",
        role: "user",
        body: "First idea",
        model: null,
        contextExcluded: false,
        createdAt: "2026-07-01T00:00:00.000Z",
      },
      {
        id: "m2",
        sessionId: "session-1",
        role: "assistant",
        body: "Excluded reply",
        model: "model-a",
        contextExcluded: true,
        createdAt: "2026-07-01T00:00:01.000Z",
      },
      {
        id: "m3",
        sessionId: "session-1",
        role: "assistant",
        body: "Second reply",
        model: "model-a",
        contextExcluded: false,
        createdAt: "2026-07-01T00:00:02.000Z",
      },
    ]);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse([])));

    const { root } = renderPane(container);
    unmounts.push(root);

    await waitForAssertion(() => {
      expect(container.querySelectorAll('[data-testid="refinery-message-row"]').length).toBe(3);
    });

    expect(container.querySelector('[data-testid="refinery-context-drawer"]')).toBeNull();

    const openButton = container.querySelector(
      '[data-testid="refinery-inspect-context-button"]',
    ) as HTMLButtonElement;
    await act(async () => {
      openButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flush();
    });

    await waitForAssertion(() => {
      expect(container.querySelector('[data-testid="refinery-context-drawer"]')).not.toBeNull();
    });

    const rows = container.querySelectorAll('[data-testid="refinery-context-drawer-row"]');
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain("First idea");
    expect(rows[1].textContent).toContain("Second reply");

    const drawer = container.querySelector('[data-testid="refinery-context-drawer"]');
    expect(drawer?.textContent).not.toContain("Excluded reply");

    const expectedChars = "First idea".length + "Second reply".length;
    const charCount = container.querySelector('[data-testid="refinery-context-drawer-char-count"]');
    expect(charCount?.textContent).toContain(String(expectedChars));
    expect(charCount?.textContent).toContain("2 messages");
  });
});
