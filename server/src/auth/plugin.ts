import fastifyCookie from "@fastify/cookie";
import type { FastifyInstance, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import type { Config } from "../config.js";
import type { Db } from "../db/index.js";
import type { Role, User } from "../db/models.js";
import { forbidden, unauthorized } from "../errors.js";
import { findSessionUser, SESSION_COOKIE } from "./session.js";
import { createUser, findUserByEmail } from "./users.js";

declare module "fastify" {
  interface FastifyRequest {
    user: User | null;
    sessionId: string | null;
  }
}

const ROLE_RANK: Record<Role, number> = { user: 0, integration_admin: 1, app_admin: 2 };

export function requireUser(req: FastifyRequest): User {
  if (!req.user) throw unauthorized();
  return req.user;
}

export function requireRole(req: FastifyRequest, role: Role): User {
  const u = requireUser(req);
  if (ROLE_RANK[u.role] < ROLE_RANK[role]) throw forbidden();
  return u;
}

export const authPlugin = fp(async function authPlugin(app: FastifyInstance, opts: { db: Db; config: Config }) {
  const { db, config } = opts;
  await app.register(fastifyCookie);
  app.decorateRequest("user", null);
  app.decorateRequest("sessionId", null);

  app.addHook("onRequest", async (req: FastifyRequest) => {
    req.user = null;
    req.sessionId = null;

    // Same-origin check for every state-changing request. Cookies are
    // SameSite=Lax already; this closes the gap for older browsers and for
    // non-browser clients that present a cookie. An unparseable or "null"
    // Origin is rejected rather than ignored.
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const origin = req.headers.origin;
      if (origin !== undefined) {
        let originHost: string | null = null;
        try {
          originHost = new URL(origin).host || null;
        } catch {
          originHost = null;
        }
        const allowed = new Set<string>();
        if (req.headers.host) allowed.add(req.headers.host);
        if (config.baseUrl) allowed.add(new URL(config.baseUrl).host);
        if (!originHost || !allowed.has(originHost)) throw forbidden("Cross-origin requests are not allowed.");
      }
    }

    const sid = req.cookies[SESSION_COOKIE];
    if (sid) {
      const user = findSessionUser(db, sid);
      if (user) {
        req.user = user;
        req.sessionId = sid;
        return;
      }
    }

    const th = config.auth.trustedHeader;
    if (th) {
      if (th.proxyToken) {
        const presented = req.headers["x-piecewise-proxy-token"];
        if (presented !== th.proxyToken) return;
      }
      const email = req.headers[th.emailHeader];
      if (typeof email === "string" && email.includes("@")) {
        let user = findUserByEmail(db, email);
        if (!user) {
          const nameHeader = th.nameHeader ? req.headers[th.nameHeader] : undefined;
          user = createUser(db, { email, name: typeof nameHeader === "string" && nameHeader ? nameHeader : email.split("@")[0]!, role: th.defaultRole, authSource: "trusted-header" });
        }
        if (!user.disabled) req.user = user;
      }
    }
  });
});
