import fastifyFormbody from "@fastify/formbody";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { adminRoutes } from "./admin/routes.js";
import { authPlugin } from "./auth/plugin.js";
import { authRoutes } from "./auth/routes.js";
import { Oidc } from "./auth/oidc.js";
import { Saml } from "./auth/saml.js";
import { createUser, countUsers, findUserByEmail } from "./auth/users.js";
import { purgeExpiredSessions, purgeSessionsNotVia } from "./auth/session.js";
import { scimRoutes } from "./scim/routes.js";
import { VERSION, type Config } from "./config.js";
import { SecretBox } from "./crypto.js";
import { openDatabase, type Db } from "./db/index.js";
import { audit, Settings } from "./db/models.js";
import { HttpError } from "./errors.js";
import { HelperService } from "./helper/service.js";
import { helperRoutes } from "./helper/routes.js";
import { integrationRoutes } from "./admin/integrations.js";
import { plansRoutes } from "./plans/routes.js";
import { PluginRegistry } from "./plugins/registry.js";

declare module "fastify" {
  interface FastifyInstance {
    ctx: AppContext;
  }
}

export interface AppContext {
  config: Config;
  db: Db;
  settings: Settings;
  registry: PluginRegistry;
  box: SecretBox;
  helper: HelperService;
  oidc: Oidc;
  saml: Saml;
}

export async function buildApp(config: Config): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.logLevel, ...(config.env === "development" ? { transport: { target: "pino-pretty", options: { translateTime: "HH:MM:ss", ignore: "pid,hostname" } } } : {}) },
    trustProxy: config.trustProxy,
    bodyLimit: 1_000_000,
  });

  const db = openDatabase(config.dbPath);
  const settings = new Settings(db);
  const registry = new PluginRegistry(
    db,
    [
      { path: config.builtinPluginsDir, source: "builtin" },
      { path: config.extraPluginsDir, source: "installed" },
    ],
    (m) => app.log.info(m),
  );
  registry.load();
  for (const p of registry.problems) app.log.warn({ dir: p.dir, errors: p.errors }, "plugin skipped");
  const box = new SecretBox(config.appSecret);
  const helper = new HelperService(db, registry, box, settings, app.log);
  const oidc = new Oidc(db, config);
  const saml = new Saml(db, config);
  const ctx: AppContext = { config, db, settings, registry, box, helper, oidc, saml };
  app.decorate("ctx", ctx);

  bootstrap(db, config, app);
  purgeExpiredSessions(db);
  if (config.auth.saml?.enforce) {
    // Enforcement takes effect at once: sessions that came through a password,
    // OIDC, or an earlier release have to be re-established through SAML.
    const ended = purgeSessionsNotVia(db, "saml");
    if (ended) app.log.info({ ended }, "SAML is enforced; ended sessions that did not come through SAML");
  }

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.code ?? "error", message: err.message });
    if (err instanceof z.ZodError)
      return reply.code(400).send({ error: "validation", message: "Some of that didn't look right.", issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) req.log.error({ err }, "request failed");
    return reply.code(status).send({ error: status >= 500 ? "internal" : "request", message: status >= 500 ? "Something went wrong on the server." : (err as Error).message });
  });

  app.addHook("onSend", async (req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "same-origin");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    // Decide by the matched route pattern, never by the raw (possibly percent-encoded) url.
    const isApi = (req.routeOptions?.url ?? "").startsWith("/api");
    if (req.url.startsWith("/assets/")) reply.header("Cache-Control", "public, max-age=31536000, immutable");
    if (!isApi) {
      reply.header(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      );
    } else {
      reply.header("Cache-Control", "no-store");
    }
  });

  await app.register(fastifyRateLimit, { max: 600, timeWindow: "1 minute", allowList: () => config.env === "test" });
  await app.register(fastifyFormbody); // the SAML assertion consumer receives a form post
  await app.register(authPlugin, { db, config });

  app.get("/api/health", async () => ({
    ok: true,
    version: VERSION,
    plugins: registry.plugins.size,
    pluginProblems: registry.problems.length,
    helper: helper.status(),
  }));

  await app.register(authRoutes, { db, config, oidc, saml, settings });
  await app.register(plansRoutes, { ctx });
  await app.register(helperRoutes, { ctx });
  await app.register(integrationRoutes, { ctx });
  await app.register(adminRoutes, { ctx });
  await app.register(scimRoutes, { ctx });

  app.get("/api/*", async () => {
    throw new HttpError(404, "No such endpoint.", "not_found");
  });

  if (config.webDistDir && existsSync(join(config.webDistDir, "index.html"))) {
    await app.register(fastifyStatic, {
      root: config.webDistDir,
      prefix: "/",
      maxAge: 0,
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/api/")) return reply.sendFile("index.html");
      return reply.code(404).send({ error: "not_found", message: "Not found." });
    });
  } else {
    app.log.warn("web build not found; only the API is served");
  }

  app.addHook("onClose", async () => {
    db.close();
  });

  return app;
}

/** Creates the first administrator from the environment when the database is empty. */
function bootstrap(db: Db, config: Config, app: FastifyInstance): void {
  const b = config.bootstrapAdmin;
  if (!b) return;
  if (countUsers(db) > 0) return;
  if (!b.password || b.password.length < 10) {
    app.log.warn("BOOTSTRAP_ADMIN_PASSWORD must be at least 10 characters; skipping bootstrap");
    return;
  }
  if (findUserByEmail(db, b.email)) return;
  const u = createUser(db, { email: b.email, name: b.name, role: "app_admin", password: b.password, mustChangePassword: true });
  audit(db, null, "setup.bootstrap", u.id, { email: u.email });
  app.log.info({ email: u.email }, "created bootstrap administrator");
}
