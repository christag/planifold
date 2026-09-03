import type { FastifyReply } from "fastify";
import type { Config } from "../config.js";
import { token } from "../crypto.js";
import type { Db } from "../db/index.js";
import { now } from "../db/index.js";
import type { User } from "../db/models.js";

export const SESSION_COOKIE = "planifold_session";

/** How a session was established. Recorded so enforcement can tell them apart. */
export type SessionVia = "local" | "oidc" | "saml";

export function createSession(db: Db, userId: string, days: number, userAgent?: string, via: SessionVia = "local"): string {
  const id = token(32);
  const created = new Date();
  const expires = new Date(created.getTime() + days * 86400_000);
  db.prepare("INSERT INTO sessions (id, user_id, created_at, expires_at, user_agent, via) VALUES (?, ?, ?, ?, ?, ?)").run(id, userId, created.toISOString(), expires.toISOString(), userAgent ?? null, via);
  db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(now(), userId);
  return id;
}

/**
 * Resolves a session cookie to its user. `requireVia` narrows which kind of
 * session counts: with SAML enforced, only sessions that came through SAML do.
 */
export function findSessionUser(db: Db, id: string, requireVia?: SessionVia): User | undefined {
  const row = db
    .prepare("SELECT u.*, s.expires_at AS session_expires, s.via AS session_via FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?")
    .get(id) as (User & { session_expires: string; session_via: string }) | undefined;
  if (!row) return undefined;
  if (row.session_expires < now() || row.disabled || (requireVia && row.session_via !== requireVia)) {
    db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    return undefined;
  }
  const { session_expires: _e, session_via: _v, ...user } = row;
  return user as User;
}

export function deleteSession(db: Db, id: string): void {
  db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
}

export function deleteUserSessions(db: Db, userId: string): void {
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
}

export function purgeExpiredSessions(db: Db): void {
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now());
}

/** Ends every session that did not come through the given method. Used when SAML is enforced. */
export function purgeSessionsNotVia(db: Db, via: SessionVia): number {
  return db.prepare("DELETE FROM sessions WHERE via <> ?").run(via).changes;
}

export function setSessionCookie(reply: FastifyReply, id: string, config: Config): void {
  reply.setCookie(SESSION_COOKIE, id, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: config.secureCookies,
    maxAge: config.sessionDays * 86400,
  });
}

export function clearSessionCookie(reply: FastifyReply, config: Config): void {
  reply.clearCookie(SESSION_COOKIE, { path: "/", httpOnly: true, sameSite: "lax", secure: config.secureCookies });
}
