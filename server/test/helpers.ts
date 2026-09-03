import type { FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.js";
import { loadConfig, type Config } from "../src/config.js";

export interface TestApp {
  app: FastifyInstance;
  dir: string;
  close(): Promise<void>;
}

export async function createTestApp(env: Record<string, string> = {}, overrides: Partial<Config> = {}): Promise<TestApp> {
  const dir = mkdtempSync(join(process.env.CLAUDE_JOB_DIR ? join(process.env.CLAUDE_JOB_DIR, "tmp") : tmpdir(), "planifold-test-"));
  const saved: Record<string, string | undefined> = {};
  const base: Record<string, string> = { NODE_ENV: "test", DATA_DIR: dir, APP_SECRET: "test-secret-do-not-use", LOG_LEVEL: "silent", BASE_URL: "", OIDC_ISSUER: "", AUTH_TRUSTED_HEADER: "", BOOTSTRAP_ADMIN_EMAIL: "", ...env };
  for (const [k, v] of Object.entries(base)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  let config: Config;
  try {
    config = loadConfig(overrides);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  const app = await buildApp(config);
  await app.ready();
  return {
    app,
    dir,
    async close() {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function cookieOf(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  return list.map((c) => c.split(";")[0]).join("; ");
}

export async function setupAdmin(t: TestApp, email = "admin@example.com", password = "correct-horse-battery") {
  const res = await t.app.inject({ method: "POST", url: "/api/auth/setup", payload: { email, name: "Admin", password, orgName: "Example Co" } });
  if (res.statusCode !== 200) throw new Error(`setup failed: ${res.body}`);
  return cookieOf(res);
}

export async function login(t: TestApp, email: string, password: string) {
  const res = await t.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.body}`);
  return cookieOf(res);
}

export async function createUserAs(t: TestApp, adminCookie: string, email: string, role = "user") {
  const res = await t.app.inject({ method: "POST", url: "/api/admin/users", headers: { cookie: adminCookie }, payload: { email, name: email.split("@")[0], role } });
  if (res.statusCode !== 200) throw new Error(`create user failed: ${res.body}`);
  const body = res.json() as { temporaryPassword: string; user: { id: string } };
  return { id: body.user.id, password: body.temporaryPassword, cookie: await login(t, email, body.temporaryPassword) };
}
