import type { Catalog } from "@piecewise/shared";
import type { AuditEntry, AuthConfig, HandoffResponse, HelperMessage, HelperResult, HelperStatus, OrgSettings, Overview, Piece, Plan, PluginInfo, PluginProblem, Provider, SuggestedSlot, User } from "./types.js";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public issues?: Array<{ path: string; message: string }>,
  ) {
    super(message);
  }
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: "same-origin",
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, "Can't reach the server. Check your connection and try again.", "network");
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const d = (data ?? {}) as { message?: string; error?: string; issues?: Array<{ path: string; message: string }> };
    if (res.status === 401 && !url.startsWith("/api/auth/")) onUnauthorized?.();
    throw new ApiError(res.status, d.message ?? `Request failed (${res.status}).`, d.error, d.issues);
  }
  return data as T;
}

const get = <T>(url: string) => request<T>("GET", url);
const post = <T>(url: string, body?: unknown) => request<T>("POST", url, body ?? {});
const patch = <T>(url: string, body: unknown) => request<T>("PATCH", url, body);
const del = <T>(url: string) => request<T>("DELETE", url);

export const api = {
  auth: {
    config: () => get<AuthConfig>("/api/auth/config"),
    me: () => get<{ user: User }>("/api/auth/me"),
    login: (email: string, password: string) => post<{ user: User }>("/api/auth/login", { email, password }),
    setup: (input: { email: string; name: string; password: string; orgName?: string }) => post<{ user: User }>("/api/auth/setup", input),
    logout: () => post<{ ok: true }>("/api/auth/logout"),
    changePassword: (input: { currentPassword?: string; newPassword: string }) => post<{ ok: true }>("/api/auth/password", input),
  },
  catalog: () => get<{ catalog: Catalog }>("/api/catalog"),
  helperStatus: () => get<HelperStatus>("/api/helper/status"),
  plans: {
    list: (all = false) => get<{ plans: Plan[] }>(`/api/plans${all ? "?all=1" : ""}`),
    create: (input: { thought: string; title?: string }) => post<{ plan: Plan; pieces: Piece[]; messages: HelperMessage[] }>("/api/plans", input),
    get: (id: string) => get<{ plan: Plan; pieces: Piece[]; messages: HelperMessage[] }>(`/api/plans/${id}`),
    update: (id: string, input: Partial<Pick<Plan, "title" | "thought" | "facts" | "status">>) => patch<{ plan: Plan }>(`/api/plans/${id}`, input),
    remove: (id: string) => del<{ ok: true }>(`/api/plans/${id}`),
    handoff: (id: string) => get<HandoffResponse>(`/api/plans/${id}/handoff`),
    brief: (id: string) => post<{ brief: string; source: "model" | "rules" }>(`/api/plans/${id}/brief`),
  },
  pieces: {
    create: (planId: string, input: { kind: Piece["kind"]; slots?: Piece["slots"]; label?: string | null; notes?: string | null }) => post<{ piece: Piece }>(`/api/plans/${planId}/pieces`, input),
    update: (planId: string, id: string, input: { slots?: Piece["slots"]; label?: string | null; notes?: string | null }) => patch<{ piece: Piece; pieces: Piece[]; dropped: string[] }>(`/api/plans/${planId}/pieces/${id}`, input),
    remove: (planId: string, id: string) => del<{ pieces: Piece[] }>(`/api/plans/${planId}/pieces/${id}`),
    reorder: (planId: string, ids: string[]) => post<{ pieces: Piece[] }>(`/api/plans/${planId}/pieces/reorder`, { ids }),
    apply: (planId: string, input: { pieceId: string | null; kind: Piece["kind"]; slots: SuggestedSlot[]; label?: string | null }) => post<{ pieceId: string; pieces: Piece[]; applied: string[]; dropped: string[] }>(`/api/plans/${planId}/pieces/apply`, input),
  },
  helper: {
    ask: (planId: string, input: { message?: string; intent: "chat" | "breakdown" | "slot" | "review"; focus?: { pieceId: string; slotId?: string } }) => post<HelperResult>(`/api/plans/${planId}/helper`, input),
    clear: (planId: string) => del<{ ok: true }>(`/api/plans/${planId}/helper`),
  },
  integrations: {
    list: () => get<{ plugins: PluginInfo[]; canManage: boolean }>("/api/integrations"),
    update: (id: string, input: { guidance?: string | null; setupNotes?: string | null; overrides?: PluginInfo["overrides"] }) => patch<{ plugin: PluginInfo }>(`/api/integrations/${id}`, input),
  },
  admin: {
    overview: () => get<Overview>("/api/admin/overview"),
    users: {
      list: () => get<{ users: User[] }>("/api/admin/users"),
      create: (input: { email: string; name: string; role: User["role"]; password?: string }) => post<{ user: User; temporaryPassword: string }>("/api/admin/users", input),
      update: (id: string, input: { name?: string; role?: User["role"]; disabled?: boolean; resetPassword?: boolean }) => patch<{ user: User; temporaryPassword?: string }>(`/api/admin/users/${id}`, input),
      remove: (id: string) => del<{ ok: true }>(`/api/admin/users/${id}`),
    },
    providers: {
      list: () => get<{ providers: Provider[] }>("/api/admin/providers"),
      create: (input: { kind: Provider["kind"]; label: string; model: string; apiKey?: string; baseUrl?: string | null }) => post<{ provider: Provider }>("/api/admin/providers", input),
      update: (id: string, input: Partial<{ kind: Provider["kind"]; label: string; model: string; apiKey: string; baseUrl: string | null }>) => patch<{ provider: Provider }>(`/api/admin/providers/${id}`, input),
      activate: (id: string) => post<{ providers: Provider[] }>(`/api/admin/providers/${id}/activate`),
      test: (id: string) => post<{ ok: boolean; message: string; provider: Provider }>(`/api/admin/providers/${id}/test`),
      remove: (id: string) => del<{ ok: true }>(`/api/admin/providers/${id}`),
    },
    settings: (input: Partial<OrgSettings>) => patch<{ settings: OrgSettings }>("/api/admin/settings", input),
    plugins: {
      list: () => get<{ plugins: PluginInfo[]; problems: PluginProblem[] }>("/api/admin/plugins"),
      update: (id: string, input: { enabled?: boolean; ownerId?: string | null; guidance?: string | null; setupNotes?: string | null; overrides?: PluginInfo["overrides"] }) => patch<{ plugin: PluginInfo }>(`/api/admin/plugins/${id}`, input),
      reload: () => post<{ plugins: PluginInfo[]; problems: PluginProblem[] }>("/api/admin/plugins/reload"),
    },
    audit: (limit = 100) => get<{ entries: AuditEntry[] }>(`/api/admin/audit?limit=${limit}`),
  },
};
