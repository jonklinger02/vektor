import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ScrollText } from "lucide-react";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { auditEventsApi, type AuditEvent } from "../api/auditEvents";
import { queryKeys } from "../lib/queryKeys";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { formatDateTime, relativeTime } from "../lib/utils";

const LIST_LIMIT = 100;

function actorBadgeVariant(actorType: AuditEvent["actorType"]) {
  switch (actorType) {
    case "user":
      return "default" as const;
    case "agent":
      return "secondary" as const;
    default:
      return "outline" as const;
  }
}

function actorLabel(event: AuditEvent) {
  if (event.actorType === "user") return event.actorUserId ?? "user";
  return event.actorType;
}

function subjectLabel(event: AuditEvent) {
  if (!event.subjectType && !event.subjectId) return "—";
  return `${event.subjectType ?? ""}${event.subjectType && event.subjectId ? " " : ""}${event.subjectId ?? ""}`;
}

function AuditEventRow({ event }: { event: AuditEvent }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetails = event.details != null && Object.keys(event.details).length > 0;

  return (
    <>
      <tr
        className={`border-b border-border/50 last:border-0 align-top ${hasDetails ? "cursor-pointer hover:bg-accent/20" : ""}`}
        onClick={() => hasDetails && setExpanded((value) => !value)}
      >
        <td className="px-3 py-1.5 whitespace-nowrap" title={formatDateTime(event.createdAt)}>
          {relativeTime(event.createdAt)}
        </td>
        <td className="px-3 py-1.5 whitespace-nowrap">
          <span className="flex items-center gap-1.5">
            <Badge variant={actorBadgeVariant(event.actorType)} className="text-[10px] px-1.5 py-0">
              {event.actorType}
            </Badge>
            <span className="max-w-40 truncate" title={actorLabel(event)}>
              {actorLabel(event)}
            </span>
          </span>
        </td>
        <td className="px-3 py-1.5 whitespace-nowrap font-mono">{event.action}</td>
        <td
          className="px-3 py-1.5 max-w-56 truncate text-muted-foreground"
          title={subjectLabel(event)}
        >
          {subjectLabel(event)}
        </td>
        <td className="px-3 py-1.5 whitespace-nowrap text-muted-foreground">
          {hasDetails ? (expanded ? "hide" : "show") : "—"}
        </td>
      </tr>
      {expanded && hasDetails && (
        <tr className="border-b border-border/50 last:border-0">
          <td colSpan={5} className="px-3 py-2 bg-accent/10">
            <pre className="whitespace-pre-wrap break-all font-mono text-[11px] text-muted-foreground">
              {JSON.stringify(event.details, null, 2)}
            </pre>
          </td>
        </tr>
      )}
    </>
  );
}

function AuditEventsCard({
  title,
  events,
  isLoading,
  error,
  actionFilter,
  onActionFilterChange,
}: {
  title: string;
  events: AuditEvent[];
  isLoading: boolean;
  error: unknown;
  actionFilter: string;
  onActionFilterChange: (value: string) => void;
}) {
  return (
    <Card>
      <CardContent className="p-0">
        <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
          <ScrollText className="h-4 w-4 text-muted-foreground" />
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {title}
          </span>
          <input
            type="text"
            value={actionFilter}
            onChange={(e) => onActionFilterChange(e.target.value)}
            placeholder="Filter by action (e.g. company.role_changed)"
            aria-label="Filter audit events by action"
            className="ml-auto w-72 max-w-full rounded-md border border-border bg-transparent px-2 py-1 text-xs outline-none"
          />
        </div>
        {isLoading ? (
          <div className="px-3 py-4 text-sm text-muted-foreground">Loading audit events...</div>
        ) : error ? (
          <div className="px-3 py-4 text-sm text-destructive">
            {error instanceof Error ? error.message : "Failed to load audit events."}
          </div>
        ) : events.length === 0 ? (
          <div className="px-3 py-4 text-sm text-muted-foreground">No audit events recorded yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border bg-accent/20">
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground">When</th>
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground">Actor</th>
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground">Action</th>
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground">Subject</th>
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground">Details</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <AuditEventRow key={event.id} event={event} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Company-scoped audit trail, under Company Settings. */
export function CompanyAuditLog() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const { selectedCompany } = useCompany();
  const [actionFilter, setActionFilter] = useState("");

  useEffect(() => {
    setBreadcrumbs([
      { label: "Settings", href: "/company/settings" },
      { label: "Audit Log" },
    ]);
  }, [setBreadcrumbs]);

  const companyId = selectedCompany?.id ?? null;
  const action = actionFilter.trim();

  const eventsQuery = useQuery({
    queryKey: companyId
      ? queryKeys.auditEvents.company(companyId, action, LIST_LIMIT)
      : (["audit-events", "company", "__disabled__"] as const),
    queryFn: () =>
      auditEventsApi.listForCompany(companyId!, {
        action: action || undefined,
        limit: LIST_LIMIT,
      }),
    enabled: !!companyId,
    refetchInterval: 15_000,
  });

  if (!selectedCompany) {
    return <div className="text-sm text-muted-foreground">Select a company to view its audit log.</div>;
  }

  return (
    <div className="max-w-5xl space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <ScrollText className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Audit Log</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Immutable record of privileged changes in {selectedCompany.name}: role and membership
          changes, budget policy updates, heartbeat reallocation, confidentiality changes, and
          exports. Entries are append-only and cannot be edited or deleted.
        </p>
      </div>
      <AuditEventsCard
        title={`Audit events — ${selectedCompany.name}`}
        events={eventsQuery.data ?? []}
        isLoading={eventsQuery.isLoading}
        error={eventsQuery.error}
        actionFilter={actionFilter}
        onActionFilterChange={setActionFilter}
      />
    </div>
  );
}

/** Instance-wide audit trail (instance admins), under Instance Settings. */
export function InstanceAuditLog() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const [actionFilter, setActionFilter] = useState("");

  useEffect(() => {
    setBreadcrumbs([
      { label: "Settings", href: "/company/settings" },
      { label: "Instance settings", href: "/company/settings/instance/general" },
      { label: "Audit Log" },
    ]);
  }, [setBreadcrumbs]);

  const action = actionFilter.trim();
  const eventsQuery = useQuery({
    queryKey: queryKeys.auditEvents.instance(action, LIST_LIMIT),
    queryFn: () => auditEventsApi.listInstance({ action: action || undefined, limit: LIST_LIMIT }),
    refetchInterval: 15_000,
  });

  return (
    <div className="max-w-5xl space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <ScrollText className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Instance Audit Log</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Immutable record of privileged changes across the whole instance, including
          instance-scoped events like routing governance (shown without a company). Entries are
          append-only and cannot be edited or deleted.
        </p>
      </div>
      <AuditEventsCard
        title="Audit events — instance-wide"
        events={eventsQuery.data ?? []}
        isLoading={eventsQuery.isLoading}
        error={eventsQuery.error}
        actionFilter={actionFilter}
        onActionFilterChange={setActionFilter}
      />
    </div>
  );
}
