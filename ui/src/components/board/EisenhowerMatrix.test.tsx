// @vitest-environment jsdom
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Issue } from "@paperclipai/shared";
import { EisenhowerMatrix } from "./EisenhowerMatrix";

const mk = (id: string, title: string, priority: Issue["priority"], importance: Issue["importance"]): Issue =>
  ({ id, identifier: `PAP-${id}`, title, priority, importance, status: "todo", assigneeAgentId: null, assigneeUserId: null } as unknown as Issue);

const FIXTURES: Issue[] = [
  mk("1", "Prod outage billing", "critical", "important"), // do
  mk("2", "Q3 roadmap", "medium", "important"), // schedule
  mk("3", "Support pings", "high", "not_important"), // delegate
  mk("4", "Old wiki cleanup", "low", "not_important"), // eliminate
  mk("5", "Untriaged idea", "low", null), // unsorted
];

/** Find the BoardColumn root whose header title matches, return its textContent. */
function columnText(container: HTMLElement, title: string): string {
  const columns = Array.from(container.querySelectorAll<HTMLElement>("div.rounded-lg"));
  const match = columns.find((col) => {
    const header = col.querySelector(".font-semibold");
    return header?.textContent?.trim() === title;
  });
  if (!match) throw new Error(`column "${title}" not found`);
  return match.textContent ?? "";
}

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});

describe("EisenhowerMatrix rendering", () => {
  it("places each issue in the correct quadrant column and unsorted strip", () => {
    flushSync(() => {
      root.render(
        <EisenhowerMatrix issues={FIXTURES} onDropQuadrant={() => {}} onDropUnsorted={() => {}} />,
      );
    });

    expect(columnText(container, "Do Now")).toContain("Prod outage billing");
    expect(columnText(container, "Schedule")).toContain("Q3 roadmap");
    expect(columnText(container, "Delegate")).toContain("Support pings");
    expect(columnText(container, "Eliminate")).toContain("Old wiki cleanup");
    expect(columnText(container, "Unsorted")).toContain("Untriaged idea");

    // A card must not leak into the wrong quadrant.
    expect(columnText(container, "Do Now")).not.toContain("Q3 roadmap");
  });
});
