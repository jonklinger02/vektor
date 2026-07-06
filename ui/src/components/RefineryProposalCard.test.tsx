// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RefineryProposal } from "@paperclipai/shared";
import { RefineryProposalCard } from "./RefineryProposalCard";

/**
 * Task 12 coverage: the proposal card is the deterministic finalize step —
 * the model never touches the write path. These tests assert (a) a task
 * create calls issuesApi.create with the edited fields + records
 * finalization + fires onDone, (b) switching kind to project routes through
 * projectsApi with a `name` field (not `title`), and (c) a create failure
 * shows an inline error and leaves the card open (no recordFinalized/onDone,
 * fields still editable).
 *
 * Radix `Select` is swapped for a plain native `<select>` (same pattern
 * RefineryChatPane.test.tsx uses) so the test exercises component logic
 * without fighting jsdom's lack of Pointer Events support. Each `<Select>`
 * usage in the card is wrapped in a `data-testid`-bearing `<div>`, so the
 * mock doesn't need to disambiguate — tests scope their queries through that
 * wrapper.
 */

const issuesApiMock = vi.hoisted(() => ({ create: vi.fn() }));
const goalsApiMock = vi.hoisted(() => ({ create: vi.fn() }));
const projectsApiMock = vi.hoisted(() => ({ create: vi.fn() }));
const refineryApiMock = vi.hoisted(() => ({ recordFinalized: vi.fn() }));

vi.mock("../api/issues", () => ({ issuesApi: issuesApiMock }));
vi.mock("../api/goals", () => ({ goalsApi: goalsApiMock }));
vi.mock("../api/projects", () => ({ projectsApi: projectsApiMock }));
vi.mock("../api/refinery", () => ({ refineryApi: refineryApiMock }));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [
      { id: "company-1", name: "Acme" },
      { id: "company-2", name: "Globex" },
    ],
    selectedCompanyId: "company-1",
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
    <select value={value ?? ""} onChange={(e) => onValueChange(e.target.value)}>
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

function baseProposal(overrides: Partial<RefineryProposal> = {}): RefineryProposal {
  return {
    kind: "task",
    title: "Ship the widget",
    description: "Build and ship the widget end to end.",
    priority: "high",
    ...overrides,
  };
}

function setInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto =
    el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function setSelectValue(el: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

let container: HTMLDivElement;
let root: Root;

function renderCard(props: {
  proposal: RefineryProposal;
  onDone: (created: { kind: string; entityId: string; companyId: string }) => void;
  onDismiss: () => void;
}) {
  act(() => {
    root.render(
      <RefineryProposalCard
        proposal={props.proposal}
        sessionId="session-1"
        onDone={props.onDone}
        onDismiss={props.onDismiss}
      />,
    );
  });
}

function q<T extends HTMLElement>(selector: string): T {
  const el = container.querySelector<T>(selector);
  if (!el) throw new Error(`not found: ${selector}`);
  return el;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  issuesApiMock.create.mockReset();
  goalsApiMock.create.mockReset();
  projectsApiMock.create.mockReset();
  refineryApiMock.recordFinalized.mockReset();
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

describe("RefineryProposalCard", () => {
  it("creates a task via issuesApi with the edited fields and records finalization", async () => {
    issuesApiMock.create.mockResolvedValue({ id: "issue-1" });
    refineryApiMock.recordFinalized.mockResolvedValue({ id: "session-1" });

    const onDone = vi.fn();
    renderCard({ proposal: baseProposal(), onDone, onDismiss: vi.fn() });

    const titleInput = q<HTMLInputElement>('[data-testid="refinery-proposal-title-input"]');
    const descriptionTextarea = q<HTMLTextAreaElement>(
      '[data-testid="refinery-proposal-description-textarea"]',
    );

    act(() => {
      setInputValue(titleInput, "Ship the widget v2");
    });
    act(() => {
      setInputValue(descriptionTextarea, "Updated description");
    });

    const priorityWrapper = q<HTMLDivElement>('[data-testid="refinery-proposal-priority-select"]');
    const prioritySelect = priorityWrapper.querySelector("select") as HTMLSelectElement;
    act(() => {
      setSelectValue(prioritySelect, "urgent");
    });

    const createButton = q<HTMLButtonElement>('[data-testid="refinery-proposal-create-button"]');
    act(() => {
      createButton.click();
    });
    await flush();

    expect(issuesApiMock.create).toHaveBeenCalledWith("company-1", {
      title: "Ship the widget v2",
      description: "Updated description",
      priority: "urgent",
    });
    expect(refineryApiMock.recordFinalized).toHaveBeenCalledWith("session-1", {
      kind: "task",
      entityId: "issue-1",
      companyId: "company-1",
    });
    expect(onDone).toHaveBeenCalledWith({
      kind: "task",
      entityId: "issue-1",
      companyId: "company-1",
    });
  });

  it("switching kind to project calls projectsApi with a name field, not title", async () => {
    projectsApiMock.create.mockResolvedValue({ id: "project-1" });
    refineryApiMock.recordFinalized.mockResolvedValue({ id: "session-1" });

    const onDone = vi.fn();
    renderCard({ proposal: baseProposal(), onDone, onDismiss: vi.fn() });

    const projectToggle = q<HTMLButtonElement>('[data-testid="refinery-proposal-kind-project"]');
    act(() => {
      projectToggle.click();
    });

    const createButton = q<HTMLButtonElement>('[data-testid="refinery-proposal-create-button"]');
    act(() => {
      createButton.click();
    });
    await flush();

    expect(projectsApiMock.create).toHaveBeenCalledWith("company-1", {
      name: "Ship the widget",
      description: "Build and ship the widget end to end.",
    });
    expect(projectsApiMock.create.mock.calls[0][1]).not.toHaveProperty("title");
    expect(refineryApiMock.recordFinalized).toHaveBeenCalledWith("session-1", {
      kind: "project",
      entityId: "project-1",
      companyId: "company-1",
    });
    expect(onDone).toHaveBeenCalledWith({
      kind: "project",
      entityId: "project-1",
      companyId: "company-1",
    });
  });

  it("shows an inline error on create failure and keeps fields editable without finalizing", async () => {
    issuesApiMock.create.mockRejectedValue(new Error("Server exploded"));

    const onDone = vi.fn();
    renderCard({ proposal: baseProposal(), onDone, onDismiss: vi.fn() });

    const createButton = q<HTMLButtonElement>('[data-testid="refinery-proposal-create-button"]');
    act(() => {
      createButton.click();
    });
    await flush();

    const errorEl = q<HTMLParagraphElement>('[data-testid="refinery-proposal-error"]');
    expect(errorEl.textContent).toContain("Server exploded");
    expect(refineryApiMock.recordFinalized).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();

    // Fields are still present and editable — the title input still reflects
    // the (unmodified) proposal title, not cleared out.
    const titleInput = q<HTMLInputElement>('[data-testid="refinery-proposal-title-input"]');
    expect(titleInput.value).toBe("Ship the widget");
    expect(titleInput.disabled).toBe(false);
  });
});
