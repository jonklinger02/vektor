import { useEffect, useState } from "react";
import type { RefineryProposal, RefineryProposalKind } from "@paperclipai/shared";
import { issuesApi } from "../api/issues";
import { goalsApi } from "../api/goals";
import { projectsApi } from "../api/projects";
import { refineryApi } from "../api/refinery";
import { useCompany } from "../context/CompanyContext";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "../lib/utils";

/**
 * Task 12: the "finalize" step of the Refinery flow. Renders the proposal
 * captured off the `done` SSE event (see RefineryChatPane) as an editable
 * card, lets the user pick which kind of entity to create (task/goal/
 * project) and which company it belongs to, and — on Create — calls the
 * matching entity-create API DIRECTLY from the browser (the model is never
 * in the write path) followed by `refineryApi.recordFinalized` to record the
 * session's finalized pointer. Failures leave the card open with an inline
 * error so the user can retry without losing their edits.
 */

const KIND_OPTIONS: { value: RefineryProposalKind; label: string }[] = [
  { value: "task", label: "Task" },
  { value: "goal", label: "Goal" },
  { value: "project", label: "Project" },
];

const PRIORITY_OPTIONS = ["low", "medium", "high", "urgent"] as const;

export interface RefineryProposalCardProps {
  proposal: RefineryProposal;
  sessionId: string;
  onDone(created: { kind: string; entityId: string; companyId: string }): void;
  onDismiss(): void;
}

export function RefineryProposalCard({
  proposal,
  sessionId,
  onDone,
  onDismiss,
}: RefineryProposalCardProps) {
  const { companies, selectedCompanyId } = useCompany();

  const [title, setTitle] = useState(proposal.title);
  const [description, setDescription] = useState(proposal.description);
  const [kind, setKind] = useState<RefineryProposalKind>(proposal.kind);
  const [companyId, setCompanyId] = useState<string>(selectedCompanyId ?? "");
  const [priority, setPriority] = useState<string>(proposal.priority ?? "medium");
  const [level, setLevel] = useState<string>(proposal.level ?? "");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // A fresh `done` event hands us a brand-new proposal object — resync the
  // editable fields (and clear any stale error) whenever that happens. This
  // component is never remounted between proposals (the parent just swaps
  // the `proposal` prop), so this effect is what keeps the form in sync.
  useEffect(() => {
    setTitle(proposal.title);
    setDescription(proposal.description);
    setKind(proposal.kind);
    setPriority(proposal.priority ?? "medium");
    setLevel(proposal.level ?? "");
    setError(null);
  }, [proposal]);

  useEffect(() => {
    setCompanyId((current) => current || selectedCompanyId || "");
  }, [selectedCompanyId]);

  async function handleCreate() {
    if (!companyId) {
      setError("Choose a company before creating.");
      return;
    }
    if (!title.trim()) {
      setError("Title is required.");
      return;
    }

    setCreating(true);
    setError(null);
    try {
      let entityId: string;
      if (kind === "task") {
        const created = await issuesApi.create(companyId, {
          title,
          description,
          priority,
        });
        entityId = created.id;
      } else if (kind === "goal") {
        const created = await goalsApi.create(companyId, {
          title,
          description,
          ...(level ? { level } : {}),
        });
        entityId = created.id;
      } else {
        const created = await projectsApi.create(companyId, {
          name: title,
          description,
        });
        entityId = created.id;
      }

      await refineryApi.recordFinalized(sessionId, { kind, entityId, companyId });
      onDone({ kind, entityId, companyId });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create. Please try again.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div
      data-testid="refinery-proposal-card"
      className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 text-sm"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Finalize proposal
        </span>
        <div
          data-testid="refinery-proposal-kind-switcher"
          role="radiogroup"
          aria-label="Proposal kind"
          className="flex gap-1 rounded-md border border-border p-0.5"
        >
          {KIND_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={kind === option.value}
              data-testid={`refinery-proposal-kind-${option.value}`}
              onClick={() => setKind(option.value)}
              className={cn(
                "rounded px-2 py-1 text-xs font-medium transition-colors",
                kind === option.value
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="refinery-proposal-title" className="text-xs text-muted-foreground">
          Title
        </label>
        <Input
          id="refinery-proposal-title"
          data-testid="refinery-proposal-title-input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="refinery-proposal-description" className="text-xs text-muted-foreground">
          Description
        </label>
        <Textarea
          id="refinery-proposal-description"
          data-testid="refinery-proposal-description-textarea"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={4}
        />
      </div>

      <div className="flex flex-wrap gap-3">
        <div className="flex min-w-[10rem] flex-1 flex-col gap-1">
          <span className="text-xs text-muted-foreground">Company</span>
          <div data-testid="refinery-proposal-company-select">
            <Select value={companyId || undefined} onValueChange={setCompanyId}>
              <SelectTrigger className="h-9 w-full text-xs">
                <SelectValue placeholder="Choose a company" />
              </SelectTrigger>
              <SelectContent>
                {companies.map((company) => (
                  <SelectItem key={company.id} value={company.id}>
                    {company.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {kind === "task" && (
          <div className="flex min-w-[8rem] flex-1 flex-col gap-1">
            <span className="text-xs text-muted-foreground">Priority</span>
            <div data-testid="refinery-proposal-priority-select">
              <Select value={priority} onValueChange={setPriority}>
                <SelectTrigger className="h-9 w-full text-xs">
                  <SelectValue placeholder="Priority" />
                </SelectTrigger>
                <SelectContent>
                  {PRIORITY_OPTIONS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        )}

        {kind === "goal" && (
          <div className="flex min-w-[8rem] flex-1 flex-col gap-1">
            <label htmlFor="refinery-proposal-level" className="text-xs text-muted-foreground">
              Level
            </label>
            <Input
              id="refinery-proposal-level"
              data-testid="refinery-proposal-level-input"
              value={level}
              onChange={(e) => setLevel(e.target.value)}
            />
          </div>
        )}
      </div>

      {error && (
        <p role="alert" data-testid="refinery-proposal-error" className="text-xs text-destructive">
          {error}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid="refinery-proposal-dismiss-button"
          onClick={onDismiss}
          disabled={creating}
        >
          Dismiss
        </Button>
        <Button
          type="button"
          size="sm"
          data-testid="refinery-proposal-create-button"
          onClick={() => void handleCreate()}
          disabled={creating}
        >
          {creating ? "Creating..." : "Create"}
        </Button>
      </div>
    </div>
  );
}
