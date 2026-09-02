import type { HandoffDocument, PieceKind, SlotValue } from "@piecewise/shared";

export type Role = "user" | "integration_admin" | "app_admin";

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  mustChangePassword: boolean;
  disabled: boolean;
  authSource: string;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface AuthConfig {
  needsSetup: boolean;
  local: boolean;
  oidc: { label: string } | null;
  trustedHeader: boolean;
  orgName: string;
}

export type PlanStatus = "draft" | "ready" | "handed_off";

export interface Plan {
  id: string;
  ownerId: string;
  title: string;
  thought: string;
  facts: string[];
  status: PlanStatus;
  brief: string | null;
  createdAt: string;
  updatedAt: string;
  pieceCount?: number;
  ownerName?: string;
}

export interface Piece {
  id: string;
  planId: string;
  kind: PieceKind;
  position: number;
  slots: Record<string, SlotValue>;
  label: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SuggestedSlot {
  id: string;
  type: "option" | "text" | "ref";
  value: string;
}

export interface Suggestion {
  title: string;
  pieceId: string | null;
  kind: PieceKind;
  slots: SuggestedSlot[];
  why: string;
  preview: string;
  applied: string[];
  dropped: string[];
  valid: boolean;
}

export interface HelperPayload {
  suggestions?: Suggestion[];
  questions?: string[];
  remember?: string[];
  source?: "model" | "rules";
  model?: string | null;
  notice?: string | null;
  intent?: string;
  focus?: { pieceId: string; slotId?: string } | null;
}

export interface HelperMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  payload: HelperPayload | null;
  createdAt: string;
}

export interface HelperResult {
  userMessageId: string;
  assistantId: string;
  message: string;
  suggestions: Suggestion[];
  questions: string[];
  remember: string[];
  source: "model" | "rules";
  model: string | null;
  notice: string | null;
  facts: string[];
}

export interface HelperStatus {
  configured: boolean;
  provider: { label: string; kind: string; model: string } | null;
}

export interface Provider {
  id: string;
  kind: "anthropic" | "openai" | "openai_compatible";
  label: string;
  model: string;
  baseUrl: string | null;
  hasKey: boolean;
  keyHint: string | null;
  isActive: boolean;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  category: string;
  icon: string | null;
  website: string | null;
  kind: "integration" | "transforms";
  roles: Array<"input" | "output">;
  source: "builtin" | "installed";
  readme: string | null;
  objects: Array<{ id: string; label: string; fieldCount: number }>;
  actions: Array<{ id: string; label: string }>;
  operations: Array<{ id: string; label: string; ai: boolean }>;
  defaultGuidance: string | null;
  defaultSetupNotes: string | null;
  docsUrl: string | null;
  enabled: boolean;
  owner: { id: string; name: string; email: string } | null;
  guidance: string | null;
  setupNotes: string | null;
  overrides: { disabledObjects?: string[]; disabledActions?: string[]; disabledOperations?: string[] };
  updatedAt: string | null;
}

export interface PluginProblem {
  dir: string;
  errors: string[];
}

export interface AuditEntry {
  id: number;
  actorId: string | null;
  actorEmail: string | null;
  action: string;
  target: string | null;
  details: unknown;
  createdAt: string;
}

export interface OrgSettings {
  orgName: string;
  orgGuidance: string;
  preferredBuilder: string;
}

export interface Overview {
  users: number;
  admins: number;
  plans: number;
  pluginsLoaded: number;
  integrationsEnabled: number;
  operationsEnabled: number;
  pluginProblems: PluginProblem[];
  helper: HelperStatus;
  settings: OrgSettings;
}

export interface HandoffResponse {
  doc: HandoffDocument;
  markdown: string;
}
