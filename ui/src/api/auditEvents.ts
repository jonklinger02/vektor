import { api } from "./client";

export interface AuditEvent {
  id: string;
  companyId: string | null;
  actorUserId: string | null;
  actorType: "user" | "agent" | "system";
  action: string;
  subjectType: string | null;
  subjectId: string | null;
  details: Record<string, unknown> | null;
  createdAt: string;
}

export interface AuditEventListOptions {
  action?: string;
  limit?: number;
}

function auditQueryString(options: AuditEventListOptions) {
  const params = new URLSearchParams();
  if (options.action) params.set("action", options.action);
  if (options.limit != null) params.set("limit", String(options.limit));
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export const auditEventsApi = {
  listForCompany: (companyId: string, options: AuditEventListOptions = {}) =>
    api.get<AuditEvent[]>(`/companies/${companyId}/audit-events${auditQueryString(options)}`),
  listInstance: (options: AuditEventListOptions = {}) =>
    api.get<AuditEvent[]>(`/audit-events${auditQueryString(options)}`),
};
