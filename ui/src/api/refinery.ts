import type { RefineryMessage, RefineryModelOption, RefinerySession } from "@paperclipai/shared";
import { api } from "./client";

export const refineryApi = {
  listSessions: () => api.get<RefinerySession[]>("/refinery/sessions"),
  createSession: (data?: { title?: string }) =>
    api.post<RefinerySession>("/refinery/sessions", data ?? {}),
  updateSession: (id: string, data: { title?: string; status?: string }) =>
    api.patch<RefinerySession>(`/refinery/sessions/${id}`, data),
  listMessages: (sessionId: string) =>
    api.get<RefineryMessage[]>(`/refinery/sessions/${sessionId}/messages`),
  toggleContext: (messageId: string, contextExcluded: boolean) =>
    api.patch<RefineryMessage>(`/refinery/messages/${messageId}/context`, { contextExcluded }),
  recordFinalized: (sessionId: string, data: { kind: string; entityId: string; companyId: string }) =>
    api.post<RefinerySession>(`/refinery/sessions/${sessionId}/finalized`, data),
  listModels: () => api.get<RefineryModelOption[]>("/refinery/models"),
};
