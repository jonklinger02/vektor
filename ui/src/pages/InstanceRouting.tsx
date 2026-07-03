import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ListOrdered, Waypoints } from "lucide-react";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import {
  routingApi,
  type RoutingConfigVersion,
  type RoutingModelSpec,
} from "../api/routing";
import { queryKeys } from "../lib/queryKeys";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { formatDateTime, relativeTime } from "../lib/utils";

/** Mirrors ALL_TASK_CLASSES in server/src/services/smart-router/types.ts. */
const TASK_CLASSES = [
  "image_visual",
  "code",
  "structured_extraction",
  "high_stakes",
  "complex_reasoning",
  "routine",
] as const;

const EXAMPLE_SPECS = `[
  { "model": "claude-haiku-4-5", "cost": 1, "capability": 2 },
  { "model": "claude-sonnet-4-6", "cost": 2, "capability": 3 },
  { "model": "claude-opus-4-8", "cost": 4, "capability": 4 }
]`;

function humanize(value: string) {
  return value.replaceAll("_", " ");
}

function statusBadgeVariant(status: RoutingConfigVersion["status"]) {
  switch (status) {
    case "active":
      return "default" as const;
    case "frozen":
    case "rejected":
      return "destructive" as const;
    default:
      return "outline" as const;
  }
}

function specsSummary(specs: RoutingModelSpec[]) {
  return specs.map((s) => `${s.model} (c${s.cost}/q${s.capability})`).join(", ");
}

function parseModelSpecs(raw: string): RoutingModelSpec[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("modelSpecs is not valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("modelSpecs must be a non-empty JSON array");
  }
  return parsed.map((entry, index) => {
    const record = entry as Record<string, unknown>;
    if (
      !record ||
      typeof record !== "object" ||
      typeof record.model !== "string" ||
      record.model.trim() === "" ||
      typeof record.cost !== "number" ||
      typeof record.capability !== "number"
    ) {
      throw new Error(`modelSpecs[${index}] must be { "model": string, "cost": 1..4, "capability": 1..4 }`);
    }
    return { model: record.model, cost: record.cost, capability: record.capability };
  });
}

function TaskClassCard({
  taskClass,
  versions,
  onError,
}: {
  taskClass: string;
  versions: RoutingConfigVersion[];
  onError: (message: string | null) => void;
}) {
  const queryClient = useQueryClient();
  const [canaryPercent, setCanaryPercent] = useState("10");

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.routing.versions });
  };

  const mutationOptions = {
    onSuccess: async () => {
      onError(null);
      await invalidate();
    },
    onError: (error: unknown) => {
      onError(error instanceof Error ? error.message : "Routing action failed.");
    },
  };

  const canaryMutation = useMutation({
    mutationFn: (versionId: string) => {
      const percent = Number.parseInt(canaryPercent, 10);
      return routingApi.promoteToCanary(versionId, percent);
    },
    ...mutationOptions,
  });
  const promoteMutation = useMutation({
    mutationFn: (versionId: string) => routingApi.promoteToActive(versionId),
    ...mutationOptions,
  });
  const freezeMutation = useMutation({
    mutationFn: () => routingApi.freeze(taskClass),
    ...mutationOptions,
  });
  const unfreezeMutation = useMutation({
    mutationFn: () => routingApi.unfreeze(taskClass),
    ...mutationOptions,
  });
  const rollbackMutation = useMutation({
    mutationFn: () => routingApi.rollback(taskClass),
    ...mutationOptions,
  });

  const busy =
    canaryMutation.isPending ||
    promoteMutation.isPending ||
    freezeMutation.isPending ||
    unfreezeMutation.isPending ||
    rollbackMutation.isPending;

  const active = versions.find((v) => v.status === "active" || v.status === "frozen") ?? null;
  const canary = versions.find((v) => v.status === "canary") ?? null;
  const percentValue = Number.parseInt(canaryPercent, 10);
  const percentValid = Number.isInteger(percentValue) && percentValue >= 1 && percentValue <= 99;
  const visible = versions
    .filter((v) => v.status !== "superseded" && v.status !== "rejected")
    .slice(0, 6);

  return (
    <Card>
      <CardContent className="p-0">
        <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {humanize(taskClass)}
          </span>
          {active ? (
            <Badge variant={statusBadgeVariant(active.status)} className="text-[10px] px-1.5 py-0">
              {active.status === "frozen" ? `frozen v${active.version}` : `active v${active.version}`}
            </Badge>
          ) : (
            <Badge variant="outline" className="text-[10px] px-1.5 py-0">
              built-in catalog
            </Badge>
          )}
          {canary && (
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
              canary v{canary.version} @ {canary.canaryPercent ?? 0}%
            </Badge>
          )}
          <span className="ml-auto flex items-center gap-1.5">
            {active?.status === "active" && (
              <Button
                variant="outline"
                size="sm"
                className="h-6 px-2 text-xs"
                disabled={busy}
                onClick={() => freezeMutation.mutate()}
              >
                Freeze
              </Button>
            )}
            {active?.status === "frozen" && (
              <Button
                variant="outline"
                size="sm"
                className="h-6 px-2 text-xs"
                disabled={busy}
                onClick={() => unfreezeMutation.mutate()}
              >
                Unfreeze
              </Button>
            )}
            {active?.previousVersionId && (
              <Button
                variant="outline"
                size="sm"
                className="h-6 px-2 text-xs"
                disabled={busy}
                onClick={() => rollbackMutation.mutate()}
              >
                Rollback
              </Button>
            )}
          </span>
        </div>

        {visible.length === 0 ? (
          <div className="px-3 py-3 text-sm text-muted-foreground">
            No versions yet — the smart router uses the built-in model catalog for this class.
          </div>
        ) : (
          <div className="divide-y">
            {visible.map((version) => (
              <div key={version.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                <span className="font-medium tabular-nums">v{version.version}</span>
                <Badge variant={statusBadgeVariant(version.status)} className="text-[10px] px-1.5 py-0">
                  {version.status}
                  {version.status === "canary" && version.canaryPercent != null
                    ? ` ${version.canaryPercent}%`
                    : ""}
                </Badge>
                <span
                  className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
                  title={specsSummary(version.modelSpecs)}
                >
                  {specsSummary(version.modelSpecs)}
                </span>
                <span className="flex items-center gap-1.5">
                  {version.status === "draft" && (
                    <>
                      <input
                        type="number"
                        min={1}
                        max={99}
                        value={canaryPercent}
                        onChange={(e) => setCanaryPercent(e.target.value)}
                        aria-label={`Canary percent for ${humanize(taskClass)}`}
                        className="w-14 rounded-md border border-border bg-transparent px-1.5 py-0.5 text-xs outline-none tabular-nums"
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 px-2 text-xs"
                        disabled={busy || !percentValid}
                        onClick={() => canaryMutation.mutate(version.id)}
                      >
                        Canary
                      </Button>
                    </>
                  )}
                  {(version.status === "draft" || version.status === "canary") && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-6 px-2 text-xs"
                      disabled={busy}
                      onClick={() => promoteMutation.mutate(version.id)}
                    >
                      Promote
                    </Button>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ProposeVersionCard({ onError }: { onError: (message: string | null) => void }) {
  const queryClient = useQueryClient();
  const [taskClass, setTaskClass] = useState<string>(TASK_CLASSES[1]);
  const [specsJson, setSpecsJson] = useState(EXAMPLE_SPECS);
  const [localError, setLocalError] = useState<string | null>(null);

  const proposeMutation = useMutation({
    mutationFn: (input: { taskClass: string; modelSpecs: RoutingModelSpec[] }) =>
      routingApi.propose(input),
    onSuccess: async () => {
      setLocalError(null);
      onError(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.routing.versions });
    },
    onError: (error: unknown) => {
      setLocalError(error instanceof Error ? error.message : "Failed to propose the version.");
    },
  });

  function handlePropose() {
    let modelSpecs: RoutingModelSpec[];
    try {
      modelSpecs = parseModelSpecs(specsJson);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "Invalid modelSpecs JSON");
      return;
    }
    setLocalError(null);
    proposeMutation.mutate({ taskClass, modelSpecs });
  }

  return (
    <Card>
      <CardContent className="p-0">
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Propose a new version
          </span>
        </div>
        <div className="space-y-3 px-3 py-3">
          <p className="text-sm text-muted-foreground">
            A version is an ordered model table for one task class:{" "}
            <code className="text-xs">{"[{ model, cost: 1..4, capability: 1..4 }]"}</code>. New
            versions start as drafts — canary or promote them above.
          </p>
          <div className="flex items-center gap-2">
            <label className="text-xs text-muted-foreground" htmlFor="routing-propose-class">
              Task class
            </label>
            <select
              id="routing-propose-class"
              value={taskClass}
              onChange={(e) => setTaskClass(e.target.value)}
              className="rounded-md border border-border bg-background px-2 py-1 text-sm outline-none"
            >
              {TASK_CLASSES.map((cls) => (
                <option key={cls} value={cls}>
                  {humanize(cls)}
                </option>
              ))}
            </select>
          </div>
          <Textarea
            value={specsJson}
            onChange={(e) => setSpecsJson(e.target.value)}
            rows={6}
            spellCheck={false}
            aria-label="Model specs JSON"
            className="font-mono text-xs"
          />
          {localError && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {localError}
            </div>
          )}
          <Button size="sm" disabled={proposeMutation.isPending} onClick={handlePropose}>
            {proposeMutation.isPending ? "Proposing..." : "Propose draft"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function RoutingDecisionsCard({ companyId, companyName }: { companyId: string; companyName: string }) {
  const auditQuery = useQuery({
    queryKey: queryKeys.routing.audit(companyId, 50),
    queryFn: () => routingApi.auditEntries(companyId, 50),
    refetchInterval: 15_000,
  });

  const entries = auditQuery.data ?? [];

  return (
    <Card>
      <CardContent className="p-0">
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <ListOrdered className="h-4 w-4 text-muted-foreground" />
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Routing decisions — {companyName}
          </span>
        </div>
        {auditQuery.isLoading ? (
          <div className="px-3 py-4 text-sm text-muted-foreground">Loading routing decisions...</div>
        ) : auditQuery.error ? (
          <div className="px-3 py-4 text-sm text-destructive">
            {auditQuery.error instanceof Error
              ? auditQuery.error.message
              : "Failed to load routing decisions."}
          </div>
        ) : entries.length === 0 ? (
          <div className="px-3 py-4 text-sm text-muted-foreground">
            No routing decisions recorded yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border bg-accent/20">
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground">When</th>
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground">Class</th>
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground">Model</th>
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground">Flags</th>
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground">Reasoning</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id} className="border-b border-border/50 last:border-0 align-top">
                    <td
                      className="px-3 py-1.5 whitespace-nowrap"
                      title={formatDateTime(entry.createdAt)}
                    >
                      {relativeTime(entry.createdAt)}
                    </td>
                    <td className="px-3 py-1.5 whitespace-nowrap">{humanize(entry.taskClass)}</td>
                    <td className="px-3 py-1.5 whitespace-nowrap font-mono">{entry.model}</td>
                    <td className="px-3 py-1.5 whitespace-nowrap">
                      <span className="flex items-center gap-1">
                        {entry.canaryBucket && (
                          <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                            canary
                          </Badge>
                        )}
                        {entry.capped && (
                          <Badge variant="destructive" className="text-[10px] px-1.5 py-0">
                            capped
                          </Badge>
                        )}
                        {!entry.routingConfigVersionId && (
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                            catalog
                          </Badge>
                        )}
                      </span>
                    </td>
                    <td
                      className="px-3 py-1.5 max-w-md truncate text-muted-foreground"
                      title={entry.reasoning}
                    >
                      {entry.reasoning}
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

export function InstanceRouting() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const { selectedCompany } = useCompany();
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([
      { label: "Settings", href: "/company/settings" },
      { label: "Instance settings", href: "/company/settings/instance/general" },
      { label: "Routing" },
    ]);
  }, [setBreadcrumbs]);

  const versionsQuery = useQuery({
    queryKey: queryKeys.routing.versions,
    queryFn: () => routingApi.listVersions(),
  });

  const byClass = useMemo(() => {
    const map = new Map<string, RoutingConfigVersion[]>();
    for (const version of versionsQuery.data ?? []) {
      const list = map.get(version.taskClass) ?? [];
      list.push(version);
      map.set(version.taskClass, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => b.version - a.version);
    }
    return map;
  }, [versionsQuery.data]);

  if (versionsQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading routing versions...</div>;
  }

  if (versionsQuery.error) {
    return (
      <div className="text-sm text-destructive">
        {versionsQuery.error instanceof Error
          ? versionsQuery.error.message
          : "Failed to load routing versions."}
      </div>
    );
  }

  return (
    <div className="max-w-5xl space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Waypoints className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Model Routing</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Versioned per-task-class model tables for the smart router: draft → canary → active, with
          freeze as an emergency pin and one-step rollback. Classes without an active version keep
          using the built-in catalog.
        </p>
      </div>

      {actionError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {actionError}
        </div>
      )}

      <div className="space-y-4">
        {TASK_CLASSES.map((taskClass) => (
          <TaskClassCard
            key={taskClass}
            taskClass={taskClass}
            versions={byClass.get(taskClass) ?? []}
            onError={setActionError}
          />
        ))}
      </div>

      <ProposeVersionCard onError={setActionError} />

      {selectedCompany && (
        <RoutingDecisionsCard companyId={selectedCompany.id} companyName={selectedCompany.name} />
      )}
    </div>
  );
}
