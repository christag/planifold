import type { PieceKind, SlotValue } from "@planifold/shared";
import { randomUUID } from "node:crypto";
import type { Db } from "./index.js";
import { now, parseJson } from "./index.js";

export type Role = "user" | "integration_admin" | "app_admin";

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  password_hash: string | null;
  must_change_password: number;
  disabled: number;
  auth_source: string;
  oidc_sub: string | null;
  saml_name_id: string | null;
  scim_external_id: string | null;
  given_name: string | null;
  family_name: string | null;
  created_at: string;
  updated_at: string | null;
  last_login_at: string | null;
}

export interface PlanRow {
  id: string;
  owner_id: string;
  title: string;
  thought: string;
  facts: string;
  status: "draft" | "ready" | "handed_off";
  brief: string | null;
  created_at: string;
  updated_at: string;
}

export interface PieceRow {
  id: string;
  plan_id: string;
  kind: PieceKind;
  position: number;
  slots: string;
  label: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProviderRow {
  id: string;
  kind: "anthropic" | "openai" | "openai_compatible";
  label: string;
  model: string;
  api_key_enc: string | null;
  base_url: string | null;
  is_active: number;
  last_test_at: string | null;
  last_test_ok: number | null;
  last_test_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface PluginSettingsRow {
  plugin_id: string;
  enabled: number;
  owner_id: string | null;
  guidance: string | null;
  setup_notes: string | null;
  overrides: string;
  updated_at: string;
}

export interface HelperMessageRow {
  id: string;
  plan_id: string;
  role: "user" | "assistant";
  content: string;
  payload: string | null;
  created_at: string;
}

export const uuid = () => randomUUID();

export function publicUser(u: User) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    mustChangePassword: !!u.must_change_password,
    disabled: !!u.disabled,
    authSource: u.auth_source,
    scimManaged: !!u.scim_external_id,
    createdAt: u.created_at,
    lastLoginAt: u.last_login_at,
  };
}
export type PublicUser = ReturnType<typeof publicUser>;

export function toPiece(r: PieceRow) {
  return {
    id: r.id,
    planId: r.plan_id,
    kind: r.kind,
    position: r.position,
    slots: parseJson<Record<string, SlotValue>>(r.slots, {}),
    label: r.label,
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
export type Piece = ReturnType<typeof toPiece>;

export function toPlan(r: PlanRow) {
  return {
    id: r.id,
    ownerId: r.owner_id,
    title: r.title,
    thought: r.thought,
    facts: parseJson<string[]>(r.facts, []),
    status: r.status,
    brief: r.brief,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
export type Plan = ReturnType<typeof toPlan>;

export function toMessage(r: HelperMessageRow) {
  return { id: r.id, role: r.role, content: r.content, payload: parseJson<unknown>(r.payload, null), createdAt: r.created_at };
}

export class Settings {
  constructor(private db: Db) {}
  get<T>(key: string, fallback: T): T {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row ? parseJson<T>(row.value, fallback) : fallback;
  }
  set(key: string, value: unknown): void {
    this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value));
  }
}

export function audit(db: Db, actor: { id: string; email: string } | null, action: string, target: string | null, details?: unknown): void {
  db.prepare("INSERT INTO audit_log (actor_id, actor_email, action, target, details, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    actor?.id ?? null,
    actor?.email ?? null,
    action,
    target,
    details === undefined ? null : JSON.stringify(details),
    now(),
  );
}
