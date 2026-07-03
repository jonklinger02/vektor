import { api } from "./client";

export type RoutingVersionStatus =
  | "draft"
  | "canary"
  | "active"
  | "frozen"
  | "superseded"
  | "rejected";

export interface RoutingModelSpec {
  model: string;
  cost: number;
  capability: number;
}

export interface RoutingConfigVersion {
  id: string;
  taskClass: string;
  version: number;
  status: RoutingVersionStatus;
  modelSpecs: RoutingModelSpec[];
  canaryPercent: number | null;
  previousVersionId: string | null;
  createdByUserId: string | null;
  promotedAt: string | null;
  frozenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RoutingDecisionAuditEntry {
  id: string;
  companyId: string;
  heartbeatRunId: string | null;
  issueId: string | null;
  adapterType: string;
  taskClass: string;
  routingConfigVersionId: string | null;
  canaryBucket: boolean;
  model: string;
  capped: boolean;
  reasoning: string;
  createdAt: string;
}

export const routingApi = {
  listVersions: (taskClass?: string) =>
    api.get<RoutingConfigVersion[]>(
      `/routing/versions${taskClass ? `?taskClass=${encodeURIComponent(taskClass)}` : ""}`,
    ),
  propose: (input: { taskClass: string; modelSpecs: RoutingModelSpec[] }) =>
    api.post<RoutingConfigVersion>("/routing/versions", input),
  promoteToCanary: (versionId: string, percent: number) =>
    api.post<RoutingConfigVersion>(`/routing/versions/${versionId}/canary`, { percent }),
  promoteToActive: (versionId: string) =>
    api.post<RoutingConfigVersion>(`/routing/versions/${versionId}/promote`, {}),
  freeze: (taskClass: string) =>
    api.post<RoutingConfigVersion>(`/routing/classes/${encodeURIComponent(taskClass)}/freeze`, {}),
  unfreeze: (taskClass: string) =>
    api.post<RoutingConfigVersion>(`/routing/classes/${encodeURIComponent(taskClass)}/unfreeze`, {}),
  rollback: (taskClass: string) =>
    api.post<RoutingConfigVersion>(`/routing/classes/${encodeURIComponent(taskClass)}/rollback`, {}),
  auditEntries: (companyId: string, limit = 50) =>
    api.get<RoutingDecisionAuditEntry[]>(
      `/companies/${companyId}/routing-audit?limit=${encodeURIComponent(String(limit))}`,
    ),
};
