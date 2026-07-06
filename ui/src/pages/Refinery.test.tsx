// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RefinerySession } from "@paperclipai/shared";
import { Refinery } from "./Refinery";

const companyState = vi.hoisted(() => ({
  selectedCompanyId: "company-1",
  selectedCompany: { id: "company-1", name: "Acme Robotics", issuePrefix: "PAP" },
  companies: [
    { id: "company-1", name: "Acme Robotics", issuePrefix: "PAP" },
    { id: "company-2", name: "Beta Corp", issuePrefix: "BETA" },
  ],
}));

const refineryApiMock = vi.hoisted(() => ({
  listSessions: vi.fn(),
  createSession: vi.fn(),
  updateSession: vi.fn(),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => companyState,
  useOptionalCompany: () => companyState,
}));

vi.mock("../api/refinery", () => ({
  refineryApi: refineryApiMock,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function session(overrides: Partial<RefinerySession> = {}): RefinerySession {
  return {
    id: "session-1",
    ownerUserId: "user-1",
    title: "Untitled session",
    status: "active",
    model: null,
    finalizedKind: null,
    finalizedEntityId: null,
    finalizedCompanyId: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
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

function renderRefinery(container: HTMLDivElement) {
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  flushSync(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/refinery"]}>
          <Refinery />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return { root, queryClient };
}

function click(el: Element | null) {
  expect(el).not.toBeNull();
  flushSync(() => {
    (el as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("Refinery page", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    refineryApiMock.listSessions.mockReset();
    refineryApiMock.createSession.mockReset();
    refineryApiMock.updateSession.mockReset();
  });

  afterEach(() => {
    container.remove();
  });

  it("lists sessions and creates one, moving selection to the created session", async () => {
    const sessionA = session({ id: "session-a", title: "Pricing rework" });
    const sessionB = session({ id: "session-b", title: "Onboarding copy" });
    const created = session({ id: "session-new", title: "New session" });

    refineryApiMock.listSessions.mockResolvedValue([sessionA, sessionB]);
    refineryApiMock.createSession.mockResolvedValue(created);

    const { root } = renderRefinery(container);

    await waitForAssertion(() => {
      expect(refineryApiMock.listSessions).toHaveBeenCalled();
      expect(container.textContent).toContain("Pricing rework");
      expect(container.textContent).toContain("Onboarding copy");
    });

    // No selection yet — chat pane stub is not rendered.
    expect(container.querySelector('[data-testid="refinery-chat-pane"]')).toBeNull();

    click(container.querySelector('[aria-label="New session"]'));

    await waitForAssertion(() => {
      expect(refineryApiMock.createSession).toHaveBeenCalled();
      const pane = container.querySelector('[data-testid="refinery-chat-pane"]');
      expect(pane).not.toBeNull();
      expect(pane?.getAttribute("data-session-id")).toBe("session-new");
    });

    flushSync(() => {
      root.unmount();
    });
  });

  it("renames a session via inline edit", async () => {
    const sessionA = session({ id: "session-a", title: "Pricing rework" });
    refineryApiMock.listSessions.mockResolvedValue([sessionA]);
    refineryApiMock.updateSession.mockResolvedValue({ ...sessionA, title: "Pricing v2" });

    const { root } = renderRefinery(container);

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Pricing rework");
    });

    const row = container.querySelector('[data-testid="refinery-session-row-session-a"]') as HTMLElement;
    expect(row).not.toBeNull();
    click(row.querySelector('[aria-label="Rename session"]'));

    const input = row.querySelector("input") as HTMLInputElement;
    expect(input).not.toBeNull();

    flushSync(() => {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!;
      nativeSetter.call(input, "Pricing v2");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    await waitForAssertion(() => {
      expect(refineryApiMock.updateSession).toHaveBeenCalledWith("session-a", { title: "Pricing v2" });
    });

    flushSync(() => {
      root.unmount();
    });
  });

  it("shows a finalized link chip that resolves to the task detail route", async () => {
    const finalized = session({
      id: "session-c",
      title: "Refund policy",
      status: "finalized",
      finalizedKind: "task",
      finalizedEntityId: "task-123",
      finalizedCompanyId: "company-1",
    });
    refineryApiMock.listSessions.mockResolvedValue([finalized]);

    const { root } = renderRefinery(container);

    await waitForAssertion(() => {
      const chip = container.querySelector('[data-testid="refinery-finalized-chip-session-c"]');
      expect(chip).not.toBeNull();
      expect(chip?.getAttribute("href")).toBe("/PAP/issues/task-123");
    });

    flushSync(() => {
      root.unmount();
    });
  });

  it("uses the finalized company's prefix for cross-company finalized links", async () => {
    const finalized = session({
      id: "session-d",
      title: "Cross-company task",
      status: "finalized",
      finalizedKind: "task",
      finalizedEntityId: "task-456",
      finalizedCompanyId: "company-2", // Different from ambient company-1
    });
    refineryApiMock.listSessions.mockResolvedValue([finalized]);

    const { root } = renderRefinery(container);

    await waitForAssertion(() => {
      const chip = container.querySelector('[data-testid="refinery-finalized-chip-session-d"]');
      expect(chip).not.toBeNull();
      // Should use company-2's prefix (BETA), not the ambient company-1's prefix (PAP)
      expect(chip?.getAttribute("href")).toBe("/BETA/issues/task-456");
    });

    flushSync(() => {
      root.unmount();
    });
  });
});
