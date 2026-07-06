import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { Issue } from "@paperclipai/shared";
import { EisenhowerMatrix } from "@/components/board/EisenhowerMatrix";
import { patchForQuadrantDrop, type Quadrant } from "@/components/board/grouping";

const mk = (
  id: string,
  title: string,
  priority: Issue["priority"],
  importance: Issue["importance"],
  status: Issue["status"] = "todo",
): Issue =>
  ({
    id,
    identifier: `PAP-${id}`,
    title,
    priority,
    importance,
    status,
    assigneeUserId: null,
    assigneeAgentId: null,
  } as unknown as Issue);

const FIXTURES: Issue[] = [
  mk("1", "Fix prod outage in billing", "critical", "important", "in_progress"),
  mk("2", "Design Q3 architecture roadmap", "medium", "important", "todo"),
  mk("3", "Answer recurring support pings", "high", "not_important", "todo"),
  mk("4", "Reorganize old wiki pages", "low", "not_important", "backlog"),
  mk("5", "Ship migration 0135", "high", "important", "in_review"),
  mk("6", "Triage new inbound bug", "critical", null, "todo"),
  mk("7", "Untriaged idea: dark mode", "low", null, "backlog"),
];

function Harness() {
  const [issues, setIssues] = useState<Issue[]>(FIXTURES);
  const apply = (id: string, data: Partial<Issue>) =>
    setIssues((prev) => prev.map((i) => (i.id === id ? { ...i, ...data } : i)));

  return (
    <div className="h-[720px] p-4">
      <EisenhowerMatrix
        issues={issues}
        assigneeName={() => null}
        onOpenIssue={(i) => window.alert(`open ${i.identifier}`)}
        onDropQuadrant={(issue, quadrant: Quadrant) => apply(issue.id, patchForQuadrantDrop(quadrant, issue))}
        onDropUnsorted={(issue) => apply(issue.id, { importance: null })}
      />
    </div>
  );
}

const meta: Meta<typeof Harness> = {
  title: "Board/EisenhowerMatrix",
  component: Harness,
  parameters: { layout: "fullscreen" },
};
export default meta;

type Story = StoryObj<typeof Harness>;

export const AllQuadrantsAndUnsorted: Story = {};
