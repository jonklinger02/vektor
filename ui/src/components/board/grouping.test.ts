import { describe, it, expect } from "vitest";
import type { Issue } from "@paperclipai/shared";
import {
  quadrantOf,
  groupByQuadrant,
  groupByStatus,
  patchForQuadrantDrop,
  patchForStatusDrop,
  isUrgent,
} from "./grouping";

const mk = (
  p: Issue["priority"],
  imp: Issue["importance"],
  status: Issue["status"] = "todo",
): Issue => ({ id: `${p}-${imp}-${status}`, priority: p, importance: imp, status } as unknown as Issue);

describe("quadrantOf", () => {
  it("urgent+important => do", () => expect(quadrantOf("critical", "important")).toBe("do"));
  it("not-urgent+important => schedule", () => expect(quadrantOf("medium", "important")).toBe("schedule"));
  it("urgent+not-important => delegate", () => expect(quadrantOf("high", "not_important")).toBe("delegate"));
  it("not-urgent+not-important => eliminate", () => expect(quadrantOf("low", "not_important")).toBe("eliminate"));
  it("null importance => null", () => expect(quadrantOf("high", null)).toBeNull());
});

describe("isUrgent", () => {
  it("critical/high urgent", () => {
    expect(isUrgent("critical")).toBe(true);
    expect(isUrgent("high")).toBe(true);
  });
  it("medium/low not urgent", () => {
    expect(isUrgent("medium")).toBe(false);
    expect(isUrgent("low")).toBe(false);
  });
});

describe("groupByQuadrant", () => {
  it("splits sorted vs unsorted", () => {
    const g = groupByQuadrant([mk("critical", "important"), mk("high", null)]);
    expect(g.quadrant.do).toHaveLength(1);
    expect(g.unsorted).toHaveLength(1);
  });
});

describe("groupByStatus", () => {
  it("buckets by status", () => {
    const g = groupByStatus([mk("low", null, "blocked"), mk("low", null, "done")]);
    expect(g.blocked).toHaveLength(1);
    expect(g.done).toHaveLength(1);
    expect(g.backlog).toHaveLength(0);
  });
});

describe("patchForQuadrantDrop", () => {
  it("do from medium/not_important: bump priority + set importance", () => {
    expect(patchForQuadrantDrop("do", mk("medium", "not_important"))).toEqual({
      importance: "important",
      priority: "high",
    });
  });
  it("do from critical/not_important: keep critical", () => {
    expect(patchForQuadrantDrop("do", mk("critical", "not_important"))).toEqual({
      importance: "important",
    });
  });
  it("schedule from critical: drop to medium", () => {
    expect(patchForQuadrantDrop("schedule", mk("critical", "important"))).toEqual({
      importance: "important",
      priority: "medium",
    });
  });
  it("eliminate from low: keep low", () => {
    expect(patchForQuadrantDrop("eliminate", mk("low", "important"))).toEqual({
      importance: "not_important",
    });
  });
});

describe("patchForStatusDrop", () => {
  it("returns status patch", () => expect(patchForStatusDrop("in_progress")).toEqual({ status: "in_progress" }));
});
