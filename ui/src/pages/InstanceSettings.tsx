import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock3, Cpu, ExternalLink, Minus, Plus, Settings } from "lucide-react";
import type { InstanceSchedulerHeartbeatAgent } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { heartbeatsApi } from "../api/heartbeats";
import { agentsApi } from "../api/agents";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { EmptyState } from "../components/EmptyState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { queryKeys } from "../lib/queryKeys";
import { formatDateTime, formatDurationMs, relativeTime } from "../lib/utils";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function humanize(value: string) {
  return value.replaceAll("_", " ");
}

function buildAgentHref(agent: InstanceSchedulerHeartbeatAgent) {
  return `/${agent.companyIssuePrefix}/agents/${encodeURIComponent(agent.agentUrlKey)}`;
}

// ─── Compute allocation (per-company heartbeat budget) ──────────────────────

const TIER_CEILING_LABELS: Record<number, string> = {
  1: "Economy",
  2: "Standard",
  3: "Advanced",
  4: "Frontier",
};

/** Mirrors server/src/services/company-heartbeat-policy.ts tierCostCeiling. */
function deriveTierCostCeiling(memory: number): number {
  if (memory >= 6) return 4;
  if (memory >= 4) return 3;
  if (memory >= 2) return 2;
  return 1;
}

/** Mirrors dispatchMinIntervalMs; null = 0 processors = dispatch paused. */
function deriveDispatchIntervalMs(processors: number): number | null {
  if (processors <= 0) return null;
  return Math.max(2_000, Math.round(60_000 / processors));
}

function AllocationStepper({
  label,
  hint,
  value,
  canIncrement,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  canIncrement: boolean;
  disabled: boolean;
  onChange: (next: number) => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="min-w-36">
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs text-muted-foreground">{hint}</div>
      </div>
      <Button
        variant="outline"
        size="sm"
        className="h-7 w-7 p-0"
        aria-label={`Decrease ${label.toLowerCase()}`}
        disabled={disabled || value <= 0}
        onClick={() => onChange(value - 1)}
      >
        <Minus className="h-3.5 w-3.5" />
      </Button>
      <span className="w-8 text-center text-sm font-semibold tabular-nums">{value}</span>
      <Button
        variant="outline"
        size="sm"
        className="h-7 w-7 p-0"
        aria-label={`Increase ${label.toLowerCase()}`}
        disabled={disabled || !canIncrement}
        onClick={() => onChange(value + 1)}
      >
        <Plus className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

function ComputeAllocationCard({ companyId, companyName }: { companyId: string; companyName: string }) {
  const queryClient = useQueryClient();
  const allocationQuery = useQuery({
    queryKey: queryKeys.heartbeatAllocation(companyId),
    queryFn: () => heartbeatsApi.getAllocation(companyId),
  });

  const [processors, setProcessors] = useState(0);
  const [memory, setMemory] = useState(0);

  const allocation = allocationQuery.data;
  useEffect(() => {
    if (!allocation) return;
    setProcessors(allocation.processors);
    setMemory(allocation.memory);
  }, [allocation]);

  const saveMutation = useMutation({
    mutationFn: () => heartbeatsApi.updateAllocation(companyId, { processors, memory }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.heartbeatAllocation(companyId) });
    },
  });

  const trust = allocation?.trust ?? 2;
  const allocated = processors + memory;
  const canIncrement = allocated < trust;
  const dirty =
    allocation != null && (processors !== allocation.processors || memory !== allocation.memory);
  const intervalMs = deriveDispatchIntervalMs(processors);
  const ceiling = deriveTierCostCeiling(memory);

  return (
    <Card>
      <CardContent className="p-0">
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <Cpu className="h-4 w-4 text-muted-foreground" />
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Compute Allocation
          </span>
          {allocation && (
            <Badge
              variant={allocation.unconfigured || !allocation.enabled ? "outline" : "default"}
              className="text-[10px] px-1.5 py-0"
            >
              {allocation.unconfigured ? "Not configured" : allocation.enabled ? "Enabled" : "Disabled"}
            </Badge>
          )}
          <span className="ml-auto text-xs text-muted-foreground tabular-nums">
            Trust ceiling: {trust} · {allocated} of {trust} allocated
          </span>
        </div>

        {allocationQuery.isLoading ? (
          <div className="px-3 py-4 text-sm text-muted-foreground">Loading allocation...</div>
        ) : allocationQuery.error ? (
          <div className="px-3 py-4 text-sm text-destructive">
            {allocationQuery.error instanceof Error
              ? allocationQuery.error.message
              : "Failed to load the compute allocation."}
          </div>
        ) : (
          <div className="space-y-4 px-3 py-3">
            <p className="text-sm text-muted-foreground">
              Trust-bounded budget for {companyName}: processors drive dispatch throughput, memory
              raises the model-tier ceiling the smart router may select.
            </p>

            <div className="space-y-3">
              <AllocationStepper
                label="Processors"
                hint="Dispatch throughput"
                value={processors}
                canIncrement={canIncrement}
                disabled={saveMutation.isPending}
                onChange={setProcessors}
              />
              <AllocationStepper
                label="Memory"
                hint="Model-tier ceiling"
                value={memory}
                canIncrement={canIncrement}
                disabled={saveMutation.isPending}
                onChange={setMemory}
              />
            </div>

            <div className="grid grid-cols-3 gap-3 rounded-md border bg-accent/20 px-3 py-2 text-sm">
              <div>
                <div className="text-xs text-muted-foreground">Dispatch interval</div>
                <div className="font-medium tabular-nums">
                  {intervalMs === null ? "Paused" : `${Math.round(intervalMs / 1000)}s`}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Max concurrent runs</div>
                <div className="font-medium tabular-nums">{processors}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Tier ceiling</div>
                <div className="font-medium">
                  {ceiling} · {TIER_CEILING_LABELS[ceiling]}
                </div>
              </div>
            </div>

            {saveMutation.error && (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                {saveMutation.error instanceof Error
                  ? saveMutation.error.message
                  : "Failed to save the allocation."}
              </div>
            )}

            <div className="flex items-center gap-2">
              <Button
                size="sm"
                disabled={!dirty || saveMutation.isPending}
                onClick={() => saveMutation.mutate()}
              >
                {saveMutation.isPending ? "Saving..." : "Save"}
              </Button>
              {dirty && !saveMutation.isPending && (
                <span className="text-xs text-muted-foreground">Unsaved changes</span>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SchedulerTelemetryCard({ companyId }: { companyId: string }) {
  const ticksQuery = useQuery({
    queryKey: queryKeys.schedulerTicks(companyId, 15),
    queryFn: () => heartbeatsApi.schedulerTicks(companyId, 15),
    refetchInterval: 15_000,
  });

  const ticks = ticksQuery.data ?? [];

  return (
    <Card>
      <CardContent className="p-0">
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <Clock3 className="h-4 w-4 text-muted-foreground" />
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Scheduler Telemetry
          </span>
        </div>
        {ticksQuery.isLoading ? (
          <div className="px-3 py-4 text-sm text-muted-foreground">Loading scheduler ticks...</div>
        ) : ticksQuery.error ? (
          <div className="px-3 py-4 text-sm text-destructive">
            {ticksQuery.error instanceof Error
              ? ticksQuery.error.message
              : "Failed to load scheduler telemetry."}
          </div>
        ) : ticks.length === 0 ? (
          <div className="px-3 py-4 text-sm text-muted-foreground">
            No scheduler ticks recorded yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border bg-accent/20">
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground">Ticked at</th>
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground">Duration</th>
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground">Dispatched</th>
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground">Requeued</th>
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground">Skipped budget</th>
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground">Skipped allocation</th>
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground">Lapsed</th>
                </tr>
              </thead>
              <tbody>
                {ticks.map((tick) => (
                  <tr key={tick.id} className="border-b border-border/50 last:border-0">
                    <td className="px-3 py-1.5 whitespace-nowrap" title={formatDateTime(tick.tickedAt)}>
                      {relativeTime(tick.tickedAt)}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {formatDurationMs(tick.durationMs)}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{tick.issuesDispatched}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{tick.runsRequeued}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{tick.skippedBudget}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{tick.skippedAllocation}</td>
                    <td className="px-3 py-1.5 text-right">
                      {tick.lapsed ? (
                        <Badge variant="destructive" className="text-[10px] px-1.5 py-0">
                          lapsed
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function InstanceSettings() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const { selectedCompany } = useCompany();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([
      { label: "Settings", href: "/company/settings" },
      { label: "Instance settings", href: "/company/settings/instance/general" },
      { label: "Heartbeats" },
    ]);
  }, [setBreadcrumbs]);

  const heartbeatsQuery = useQuery({
    queryKey: queryKeys.instance.schedulerHeartbeats,
    queryFn: () => heartbeatsApi.listInstanceSchedulerAgents(),
    refetchInterval: 15_000,
  });

  const toggleMutation = useMutation({
    mutationFn: async (agentRow: InstanceSchedulerHeartbeatAgent) => {
      const agent = await agentsApi.get(agentRow.id, agentRow.companyId);
      const runtimeConfig = asRecord(agent.runtimeConfig) ?? {};
      const heartbeat = asRecord(runtimeConfig.heartbeat) ?? {};

      return agentsApi.update(
        agentRow.id,
        {
          runtimeConfig: {
            ...runtimeConfig,
            heartbeat: {
              ...heartbeat,
              enabled: !agentRow.heartbeatEnabled,
            },
          },
        },
        agentRow.companyId,
      );
    },
    onSuccess: async (_, agentRow) => {
      setActionError(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.instance.schedulerHeartbeats }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(agentRow.companyId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentRow.id) }),
      ]);
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "Failed to update heartbeat.");
    },
  });

  const disableAllMutation = useMutation({
    mutationFn: async (agentRows: InstanceSchedulerHeartbeatAgent[]) => {
      const enabled = agentRows.filter((a) => a.heartbeatEnabled);
      if (enabled.length === 0) return enabled;

      const results = await Promise.allSettled(
        enabled.map(async (agentRow) => {
          const agent = await agentsApi.get(agentRow.id, agentRow.companyId);
          const runtimeConfig = asRecord(agent.runtimeConfig) ?? {};
          const heartbeat = asRecord(runtimeConfig.heartbeat) ?? {};
          await agentsApi.update(
            agentRow.id,
            {
              runtimeConfig: {
                ...runtimeConfig,
                heartbeat: { ...heartbeat, enabled: false },
              },
            },
            agentRow.companyId,
          );
        }),
      );

      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failures.length > 0) {
        const firstError = failures[0]?.reason;
        const detail = firstError instanceof Error ? firstError.message : "Unknown error";
        throw new Error(
          failures.length === 1
            ? `Failed to disable 1 timer heartbeat: ${detail}`
            : `Failed to disable ${failures.length} of ${enabled.length} timer heartbeats. First error: ${detail}`,
        );
      }
      return enabled;
    },
    onSuccess: async (updatedRows) => {
      setActionError(null);
      const companies = new Set(updatedRows.map((row) => row.companyId));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.instance.schedulerHeartbeats }),
        ...Array.from(companies, (companyId) =>
          queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) }),
        ),
        ...updatedRows.map((row) =>
          queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(row.id) }),
        ),
      ]);
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "Failed to disable all heartbeats.");
    },
  });

  const agents = heartbeatsQuery.data ?? [];
  const activeCount = agents.filter((agent) => agent.schedulerActive).length;
  const disabledCount = agents.length - activeCount;
  const enabledCount = agents.filter((agent) => agent.heartbeatEnabled).length;
  const anyEnabled = enabledCount > 0;

  const grouped = useMemo(() => {
    const map = new Map<string, { companyName: string; agents: InstanceSchedulerHeartbeatAgent[] }>();
    for (const agent of agents) {
      let group = map.get(agent.companyId);
      if (!group) {
        group = { companyName: agent.companyName, agents: [] };
        map.set(agent.companyId, group);
      }
      group.agents.push(agent);
    }
    return [...map.values()];
  }, [agents]);

  if (heartbeatsQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading scheduler heartbeats...</div>;
  }

  if (heartbeatsQuery.error) {
    return (
      <div className="text-sm text-destructive">
        {heartbeatsQuery.error instanceof Error
          ? heartbeatsQuery.error.message
          : "Failed to load scheduler heartbeats."}
      </div>
    );
  }

  return (
    <div className="max-w-5xl space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Settings className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Scheduler Heartbeats</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Agents with a timer heartbeat enabled across all of your companies.
        </p>
      </div>

      <div className="flex items-center gap-4 text-sm text-muted-foreground">
        <span><span className="font-semibold text-foreground">{activeCount}</span> active</span>
        <span><span className="font-semibold text-foreground">{disabledCount}</span> disabled</span>
        <span><span className="font-semibold text-foreground">{grouped.length}</span> {grouped.length === 1 ? "company" : "companies"}</span>
        {anyEnabled && (
          <Button
            variant="destructive"
            size="sm"
            className="ml-auto h-7 text-xs"
            disabled={disableAllMutation.isPending}
            onClick={() => {
              const noun = enabledCount === 1 ? "agent" : "agents";
              if (!window.confirm(`Disable timer heartbeats for all ${enabledCount} enabled ${noun}?`)) {
                return;
              }
              disableAllMutation.mutate(agents);
            }}
          >
            {disableAllMutation.isPending ? "Disabling..." : "Disable All"}
          </Button>
        )}
      </div>

      {actionError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {actionError}
        </div>
      )}

      {agents.length === 0 ? (
        <EmptyState
          icon={Clock3}
          message="No scheduler heartbeats match the current criteria."
        />
      ) : (
        <div className="space-y-4">
          {grouped.map((group) => (
            <Card key={group.companyName}>
              <CardContent className="p-0">
                <div className="border-b px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {group.companyName}
                </div>
                <div className="divide-y">
                  {group.agents.map((agent) => {
                    const saving = toggleMutation.isPending && toggleMutation.variables?.id === agent.id;
                    return (
                      <div
                        key={agent.id}
                        className="flex items-center gap-3 px-3 py-2 text-sm"
                      >
                        <Badge
                          variant={agent.schedulerActive ? "default" : "outline"}
                          className="shrink-0 text-[10px] px-1.5 py-0"
                        >
                          {agent.schedulerActive ? "On" : "Off"}
                        </Badge>
                        <Link
                          to={buildAgentHref(agent)}
                          className="font-medium truncate hover:underline"
                        >
                          {agent.agentName}
                        </Link>
                        <span className="hidden sm:inline text-muted-foreground truncate">
                          {humanize(agent.title ?? agent.role)}
                        </span>
                        <span className="text-muted-foreground tabular-nums shrink-0">
                          {agent.intervalSec}s
                        </span>
                        <span
                          className="hidden md:inline text-muted-foreground truncate"
                          title={agent.lastHeartbeatAt ? formatDateTime(agent.lastHeartbeatAt) : undefined}
                        >
                          {agent.lastHeartbeatAt
                            ? relativeTime(agent.lastHeartbeatAt)
                            : "never"}
                        </span>
                        <span className="ml-auto flex items-center gap-1.5 shrink-0">
                          <Link
                            to={buildAgentHref(agent)}
                            className="text-muted-foreground hover:text-foreground"
                            title="Full agent config"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </Link>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2 text-xs"
                            disabled={saving}
                            onClick={() => toggleMutation.mutate(agent)}
                          >
                            {saving ? "..." : agent.heartbeatEnabled ? "Disable Timer Heartbeat" : "Enable Timer Heartbeat"}
                          </Button>
                        </span>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {selectedCompany && (
        <>
          <ComputeAllocationCard companyId={selectedCompany.id} companyName={selectedCompany.name} />
          <SchedulerTelemetryCard companyId={selectedCompany.id} />
        </>
      )}
    </div>
  );
}
