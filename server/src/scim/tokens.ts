/**
 * Bearer tokens for SCIM clients. The token is shown once when created and
 * stored as a SHA-256 hash; a request is authenticated by hashing the
 * presented token and looking the hash up.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { token as randomToken } from "../crypto.js";
import type { Db } from "../db/index.js";
import { now } from "../db/index.js";
import { uuid } from "../db/models.js";

export interface ScimTokenRow {
  id: string;
  label: string;
  token_hash: string;
  prefix: string;
  created_by: string | null;
  created_at: string;
  last_used_at: string | null;
}

const PREFIX = "pfd_scim_";

function hashToken(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function createScimToken(db: Db, label: string, createdBy: string | null): { row: ScimTokenRow; secret: string } {
  const secret = PREFIX + randomToken(32);
  const id = uuid();
  db.prepare("INSERT INTO scim_tokens (id, label, token_hash, prefix, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, label.trim(), hashToken(secret), secret.slice(0, PREFIX.length + 4), createdBy, now());
  return { row: findScimToken(db, id)!, secret };
}

export function findScimToken(db: Db, id: string): ScimTokenRow | undefined {
  return db.prepare("SELECT * FROM scim_tokens WHERE id = ?").get(id) as ScimTokenRow | undefined;
}

export function listScimTokens(db: Db): ScimTokenRow[] {
  return db.prepare("SELECT * FROM scim_tokens ORDER BY created_at").all() as ScimTokenRow[];
}

export function deleteScimToken(db: Db, id: string): boolean {
  return db.prepare("DELETE FROM scim_tokens WHERE id = ?").run(id).changes > 0;
}

export function countScimTokens(db: Db): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM scim_tokens").get() as { n: number }).n;
}

/** Resolves an `Authorization: Bearer …` header to a token row, or null. */
export function authenticateScim(db: Db, authorization: string | undefined): ScimTokenRow | null {
  if (!authorization) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(authorization);
  if (!m) return null;
  const presented = hashToken(m[1]!);
  const row = db.prepare("SELECT * FROM scim_tokens WHERE token_hash = ?").get(presented) as ScimTokenRow | undefined;
  if (!row) return null;
  const a = Buffer.from(presented, "hex");
  const b = Buffer.from(row.token_hash, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  // "Last used" is informational; write it at most once a minute.
  if (!row.last_used_at || Date.now() - new Date(row.last_used_at).getTime() > 60_000) {
    row.last_used_at = now();
    db.prepare("UPDATE scim_tokens SET last_used_at = ? WHERE id = ?").run(row.last_used_at, row.id);
  }
  return row;
}

export function publicScimToken(row: ScimTokenRow) {
  return { id: row.id, label: row.label, prefix: `${row.prefix}…`, createdAt: row.created_at, lastUsedAt: row.last_used_at };
}
