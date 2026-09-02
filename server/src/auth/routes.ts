import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import { verifyPassword } from "../crypto.js";
import type { Db } from "../db/index.js";
import { audit, publicUser } from "../db/models.js";
import { badRequest, conflict, forbidden, unauthorized } from "../errors.js";
import type { Oidc } from "./oidc.js";
import { requireUser } from "./plugin.js";
import { clearSessionCookie, createSession, deleteSession, setSessionCookie } from "./session.js";
import { countUsers, createUser, findUserByEmail, findUserByOidcSub, updateUser } from "./users.js";

const Credentials = z.object({ email: z.string().email(), password: z.string().min(1) });
const Setup = z.object({ email: z.string().email(), name: z.string().min(1).max(120), password: z.string().min(10).max(200), orgName: z.string().max(120).optional() });
const PasswordChange = z.object({ currentPassword: z.string().optional(), newPassword: z.string().min(10).max(200) });

const OIDC_FLOW_COOKIE = "piecewise_oidc";

/** Only a same-site path: one leading slash, no backslashes, no whitespace. */
function safeRedirect(value: string | undefined): string | undefined {
  return value && /^\/(?![\/\\])[^\s\\]*$/.test(value) ? value : undefined;
}

export async function authRoutes(app: FastifyInstance, opts: { db: Db; config: Config; oidc: Oidc; settings: { get<T>(k: string, f: T): T; set(k: string, v: unknown): void } }) {
  const { db, config, oidc, settings } = opts;

  app.get("/api/auth/config", async () => ({
    needsSetup: countUsers(db) === 0,
    local: config.auth.local,
    oidc: config.auth.oidc ? { label: config.auth.oidc.buttonLabel } : null,
    trustedHeader: !!config.auth.trustedHeader,
    orgName: settings.get<string>("orgName", ""),
  }));

  app.get("/api/auth/me", async (req) => {
    const u = requireUser(req);
    return { user: publicUser(u) };
  });

  /** First run: creates the first app administrator. Only works while there are no users. */
  app.post("/api/auth/setup", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (req, reply) => {
    if (countUsers(db) > 0) throw conflict("Setup has already been completed.");
    const body = Setup.parse(req.body);
    const user = createUser(db, { email: body.email, name: body.name, role: "app_admin", password: body.password });
    if (body.orgName) settings.set("orgName", body.orgName.trim());
    audit(db, { id: user.id, email: user.email }, "setup.completed", user.id);
    const sid = createSession(db, user.id, config.sessionDays, req.headers["user-agent"]);
    setSessionCookie(reply, sid, config);
    return { user: publicUser(user) };
  });

  app.post("/api/auth/login", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    if (!config.auth.local) throw forbidden("Password sign-in is turned off. Use single sign-on.");
    const body = Credentials.parse(req.body);
    const user = findUserByEmail(db, body.email);
    const ok = !!user && !user.disabled && verifyPassword(body.password, user.password_hash);
    if (!ok || !user) {
      audit(db, null, "login.failed", body.email.toLowerCase());
      throw unauthorized("That email and password don't match.");
    }
    const sid = createSession(db, user.id, config.sessionDays, req.headers["user-agent"]);
    setSessionCookie(reply, sid, config);
    audit(db, { id: user.id, email: user.email }, "login.succeeded", user.id);
    return { user: publicUser(user) };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    if (req.sessionId) deleteSession(db, req.sessionId);
    clearSessionCookie(reply, config);
    return { ok: true };
  });

  app.post("/api/auth/password", async (req) => {
    const u = requireUser(req);
    if (u.auth_source !== "local") throw badRequest("Your password is managed by your identity provider.");
    const body = PasswordChange.parse(req.body);
    if (!u.must_change_password && !verifyPassword(body.currentPassword ?? "", u.password_hash)) throw badRequest("Current password is wrong.");
    updateUser(db, u.id, { password: body.newPassword, mustChangePassword: false });
    audit(db, { id: u.id, email: u.email }, "password.changed", u.id);
    return { ok: true };
  });

  app.get("/api/auth/oidc/start", async (req, reply) => {
    if (!oidc.enabled) throw badRequest("Single sign-on is not configured.");
    const q = req.query as { redirect?: string };
    const { url, flowId } = await oidc.start(safeRedirect(q.redirect));
    reply.setCookie(OIDC_FLOW_COOKIE, flowId, { path: "/api/auth/oidc", httpOnly: true, sameSite: "lax", secure: config.secureCookies, maxAge: 600 });
    return reply.redirect(url, 302);
  });

  app.get("/api/auth/oidc/callback", async (req, reply) => {
    if (!oidc.enabled) throw badRequest("Single sign-on is not configured.");
    const flowId = req.cookies[OIDC_FLOW_COOKIE];
    reply.clearCookie(OIDC_FLOW_COOKIE, { path: "/api/auth/oidc" });
    if (!flowId) return reply.redirect("/login?error=" + encodeURIComponent("This sign-in attempt expired. Start again."), 302);
    const base = config.baseUrl ?? `${req.protocol}://${req.headers.host}`;
    try {
      const identity = await oidc.finish(flowId, new URL(req.url, base));
      const o = config.auth.oidc!;
      // Identity is the provider's stable subject. Email is only used to create
      // or, once, to link an account; a provider that says the address is
      // unverified cannot claim an existing one.
      let user = findUserByOidcSub(db, identity.sub);
      if (!user) {
        const byEmail = findUserByEmail(db, identity.email);
        if (byEmail) {
          if (identity.emailVerified === false) {
            audit(db, null, "login.failed", identity.email, { via: "oidc", reason: "email not verified" });
            return reply.redirect("/login?error=" + encodeURIComponent("Your identity provider reports this email address as unverified, so it can't be linked to an existing account."), 302);
          }
          if (byEmail.oidc_sub && byEmail.oidc_sub !== identity.sub) {
            audit(db, null, "login.failed", identity.email, { via: "oidc", reason: "subject mismatch" });
            return reply.redirect("/login?error=" + encodeURIComponent("This account is linked to a different single sign-on identity."), 302);
          }
          user = updateUser(db, byEmail.id, { oidcSub: identity.sub, authSource: "oidc" });
          audit(db, { id: user.id, email: user.email }, "user.linked", user.id, { via: "oidc" });
        } else {
          const role = o.adminEmails.includes(identity.email) ? "app_admin" : o.defaultRole;
          user = createUser(db, { email: identity.email, name: identity.name, role, authSource: "oidc", oidcSub: identity.sub });
          audit(db, { id: user.id, email: user.email }, "user.created", user.id, { via: "oidc", role });
        }
      }
      if (user.disabled) return reply.redirect("/login?error=" + encodeURIComponent("This account is disabled."), 302);
      const sid = createSession(db, user.id, config.sessionDays, req.headers["user-agent"]);
      setSessionCookie(reply, sid, config);
      audit(db, { id: user.id, email: user.email }, "login.succeeded", user.id, { via: "oidc" });
      return reply.redirect(identity.redirectTo ?? "/", 302);
    } catch (e) {
      req.log.warn({ err: e }, "oidc callback failed");
      return reply.redirect("/login?error=" + encodeURIComponent((e as Error).message || "Sign-in failed."), 302);
    }
  });
}
