import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import { verifyPassword } from "../crypto.js";
import type { Db } from "../db/index.js";
import { audit, publicUser, type User } from "../db/models.js";
import { badRequest, conflict, forbidden, notFound, unauthorized } from "../errors.js";
import type { Oidc } from "./oidc.js";
import { requireUser } from "./plugin.js";
import { safeRedirect, type Saml, type SamlIdentity } from "./saml.js";
import { clearSessionCookie, createSession, deleteSession, setSessionCookie } from "./session.js";
import { countUsers, createUser, findUserByEmail, findUserByOidcSub, findUserBySamlNameId, findUserByScimExternalId, updateUser } from "./users.js";

const Credentials = z.object({ email: z.string().email(), password: z.string().min(1) });
const Setup = z.object({ email: z.string().email(), name: z.string().min(1).max(120), password: z.string().min(10).max(200), orgName: z.string().max(120).optional() });
const PasswordChange = z.object({ currentPassword: z.string().optional(), newPassword: z.string().min(10).max(200) });
const SamlResponse = z.object({ SAMLResponse: z.string().min(1), RelayState: z.string().max(200).optional() });

const OIDC_FLOW_COOKIE = "piecewise_oidc";

export async function authRoutes(app: FastifyInstance, opts: { db: Db; config: Config; oidc: Oidc; saml: Saml; settings: { get<T>(k: string, f: T): T; set(k: string, v: unknown): void } }) {
  const { db, config, oidc, saml, settings } = opts;
  const loginError = (message: string) => "/login?error=" + encodeURIComponent(message);

  app.get("/api/auth/config", async () => ({
    // A local administrator is only worth creating when passwords can be used.
    // With password sign-in off, the first administrator comes through single
    // sign-on (OIDC_ADMIN_EMAILS / SAML_ADMIN_EMAILS) instead.
    needsSetup: config.auth.local && countUsers(db) === 0,
    local: config.auth.local,
    oidc: config.auth.oidc ? { label: config.auth.oidc.buttonLabel } : null,
    saml: config.auth.saml ? { label: config.auth.saml.buttonLabel, enforced: config.auth.saml.enforce } : null,
    trustedHeader: !!config.auth.trustedHeader,
    orgName: settings.get<string>("orgName", ""),
  }));

  app.get("/api/auth/me", async (req) => {
    const u = requireUser(req);
    return { user: publicUser(u) };
  });

  /** First run: creates the first app administrator. Only works while there are no users. */
  app.post("/api/auth/setup", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (req, reply) => {
    if (!config.auth.local) throw forbidden("Password sign-in is turned off. The first administrator is created by single sign-on.");
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

  // OpenID Connect

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
    if (!flowId) return reply.redirect(loginError("This sign-in attempt expired. Start again."), 302);
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
            return reply.redirect(loginError("Your identity provider reports this email address as unverified, so it can't be linked to an existing account."), 302);
          }
          if (byEmail.oidc_sub && byEmail.oidc_sub !== identity.sub) {
            audit(db, null, "login.failed", identity.email, { via: "oidc", reason: "subject mismatch" });
            return reply.redirect(loginError("This account is linked to a different single sign-on identity."), 302);
          }
          user = updateUser(db, byEmail.id, { oidcSub: identity.sub, authSource: "oidc" });
          audit(db, { id: user.id, email: user.email }, "user.linked", user.id, { via: "oidc" });
        } else {
          const role = o.adminEmails.includes(identity.email) ? "app_admin" : o.defaultRole;
          user = createUser(db, { email: identity.email, name: identity.name, role, authSource: "oidc", oidcSub: identity.sub });
          audit(db, { id: user.id, email: user.email }, "user.created", user.id, { via: "oidc", role });
        }
      }
      if (user.disabled) return reply.redirect(loginError("This account is disabled."), 302);
      const sid = createSession(db, user.id, config.sessionDays, req.headers["user-agent"], "oidc");
      setSessionCookie(reply, sid, config);
      audit(db, { id: user.id, email: user.email }, "login.succeeded", user.id, { via: "oidc" });
      return reply.redirect(identity.redirectTo ?? "/", 302);
    } catch (e) {
      req.log.warn({ err: e }, "oidc callback failed");
      return reply.redirect(loginError((e as Error).message || "Sign-in failed."), 302);
    }
  });

  // SAML 2.0

  app.get("/api/auth/saml/start", async (req, reply) => {
    if (!saml.enabled) throw badRequest("SAML single sign-on is not configured.");
    const q = req.query as { redirect?: string };
    const url = await saml.start(safeRedirect(q.redirect));
    return reply.redirect(url, 302);
  });

  /** Service-provider metadata for the identity provider's administrator. */
  app.get("/api/auth/saml/metadata", async (_req, reply) => {
    if (!saml.enabled) throw notFound("SAML single sign-on is not configured.");
    return reply.type("application/xml; charset=utf-8").send(saml.metadata());
  });

  /**
   * Assertion consumer service. The identity provider's page posts here from
   * its own origin, so the route opts out of the same-origin check; the
   * response is authenticated by its XML signature, not by a cookie.
   */
  app.post("/api/auth/saml/callback", { config: { allowCrossOrigin: true, rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
    if (!saml.enabled) throw badRequest("SAML single sign-on is not configured.");
    const parsed = SamlResponse.safeParse(req.body);
    if (!parsed.success) return reply.redirect(loginError("The identity provider sent an incomplete response. Start again."), 302);
    try {
      const identity = await saml.finish(parsed.data);
      const user = resolveSamlUser(db, config, identity);
      if ("error" in user) {
        audit(db, null, "login.failed", identity.email, { via: "saml", reason: user.reason });
        return reply.redirect(loginError(user.error), 302);
      }
      if (user.disabled) return reply.redirect(loginError("This account is disabled."), 302);
      const sid = createSession(db, user.id, config.sessionDays, req.headers["user-agent"], "saml");
      setSessionCookie(reply, sid, config);
      audit(db, { id: user.id, email: user.email }, "login.succeeded", user.id, { via: "saml", solicited: identity.solicited });
      return reply.redirect(identity.redirectTo ?? "/", 302);
    } catch (e) {
      req.log.warn({ err: e }, "saml callback failed");
      return reply.redirect(loginError(samlErrorMessage(e)), 302);
    }
  });
}

/**
 * Maps a SAML identity to an account. Identity is the NameID; it is looked up
 * first, then a SCIM-provisioned account whose external id equals the NameID
 * (Okta can send its user id as both), then an existing account with the same
 * email, which is linked once. Otherwise an account is created.
 */
function resolveSamlUser(db: Db, config: Config, identity: SamlIdentity): User | { error: string; reason: string } {
  const s = config.auth.saml!;
  const isAdmin = s.adminEmails.includes(identity.email) || identity.groups.some((g) => s.adminGroups.includes(g));
  let user = findUserBySamlNameId(db, identity.nameId);
  if (user) return user;
  const existing = findUserByScimExternalId(db, identity.nameId) ?? findUserByEmail(db, identity.email);
  if (existing) {
    if (existing.saml_name_id && existing.saml_name_id !== identity.nameId) {
      return { error: "This account is linked to a different single sign-on identity.", reason: "name id mismatch" };
    }
    // An account provisioned by SCIM that has never signed in gets its role
    // decided now, the same way a freshly created one would; only upwards.
    const promote = existing.auth_source === "scim" && !existing.last_login_at && isAdmin && existing.role !== "app_admin";
    user = updateUser(db, existing.id, {
      samlNameId: identity.nameId,
      ...(existing.auth_source === "local" || existing.auth_source === "scim" ? { authSource: "saml" } : {}),
      ...(promote ? { role: "app_admin" } : {}),
    });
    audit(db, { id: user.id, email: user.email }, "user.linked", user.id, { via: "saml", ...(promote ? { role: "app_admin" } : {}) });
    return user;
  }
  const role = isAdmin ? "app_admin" : s.defaultRole;
  user = createUser(db, { email: identity.email, name: identity.name, role, authSource: "saml", samlNameId: identity.nameId, givenName: identity.givenName, familyName: identity.familyName });
  audit(db, { id: user.id, email: user.email }, "user.created", user.id, { via: "saml", role });
  return user;
}

/** node-saml's messages are precise but terse; say what the person can do about the common ones. */
function samlErrorMessage(e: unknown): string {
  const m = (e as Error)?.message ?? "";
  if (/InResponseTo is missing/i.test(m)) return "Sign-in must start from Piecewise. Open the sign-in page and try again.";
  if (/InResponseTo is not valid|SubjectInResponseTo/i.test(m)) return "This sign-in attempt expired or was already used. Start again.";
  if (/Invalid (document )?signature|Invalid signature/i.test(m)) return "The identity provider's response could not be verified. Ask your administrator to check the SAML certificate.";
  if (/audience mismatch/i.test(m)) return "The identity provider sent this response to a different application. Ask your administrator to check the audience (entity id).";
  if (/SAML assertion (expired|not yet valid)|No valid subject confirmation/i.test(m)) return "The identity provider's response has expired. Check the clocks and try again.";
  if (/Unknown SAML issuer/i.test(m)) return "The response came from an unexpected identity provider. Ask your administrator to check SAML_IDP_ISSUER.";
  if (/SAML provider returned/i.test(m)) return `The identity provider refused the sign-in: ${m.replace(/^SAML provider returned /, "")}`;
  return m || "Sign-in failed.";
}
