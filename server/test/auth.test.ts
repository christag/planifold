import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cookieOf, createTestApp, createUserAs, login, setupAdmin, type TestApp } from "./helpers.js";

describe("authentication and roles", () => {
  let t: TestApp;
  let admin: string;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it("reports that setup is needed, then completes it once", async () => {
    const before = await t.app.inject({ method: "GET", url: "/api/auth/config" });
    expect(before.json()).toMatchObject({ needsSetup: true, local: true, oidc: null });
    admin = await setupAdmin(t);
    const me = await t.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: admin } });
    expect(me.json().user).toMatchObject({ email: "admin@example.com", role: "app_admin" });
    const again = await t.app.inject({ method: "POST", url: "/api/auth/setup", payload: { email: "x@example.com", name: "X", password: "another-long-password" } });
    expect(again.statusCode).toBe(409);
    const after = await t.app.inject({ method: "GET", url: "/api/auth/config" });
    expect(after.json()).toMatchObject({ needsSetup: false, orgName: "Example Co" });
  });

  it("rejects bad passwords and unauthenticated access", async () => {
    const bad = await t.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@example.com", password: "nope" } });
    expect(bad.statusCode).toBe(401);
    const anon = await t.app.inject({ method: "GET", url: "/api/plans" });
    expect(anon.statusCode).toBe(401);
  });

  it("creates users with a one-time password they must change", async () => {
    const u = await createUserAs(t, admin, "sam@example.com");
    const me = await t.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: u.cookie } });
    expect(me.json().user).toMatchObject({ role: "user", mustChangePassword: true });
    const change = await t.app.inject({ method: "POST", url: "/api/auth/password", headers: { cookie: u.cookie }, payload: { newPassword: "a-much-better-password" } });
    expect(change.statusCode).toBe(200);
    const relogin = await login(t, "sam@example.com", "a-much-better-password");
    expect(relogin).toContain("piecewise_session=");
  });

  it("keeps admin routes away from users and integration admins", async () => {
    const u = await createUserAs(t, admin, "ia@example.com", "integration_admin");
    const denied = await t.app.inject({ method: "GET", url: "/api/admin/users", headers: { cookie: u.cookie } });
    expect(denied.statusCode).toBe(403);
    const mine = await t.app.inject({ method: "GET", url: "/api/integrations", headers: { cookie: u.cookie } });
    expect(mine.json()).toMatchObject({ canManage: true, plugins: [] });
  });

  it("logs out and invalidates the session", async () => {
    const cookie = await login(t, "admin@example.com", "correct-horse-battery");
    const out = await t.app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie } });
    expect(out.statusCode).toBe(200);
    const me = await t.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    expect(me.statusCode).toBe(401);
  });

  it("blocks cross-origin state changes, including null and garbage origins", async () => {
    for (const origin of ["https://evil.example", "null", "not a url", ""]) {
      const res = await t.app.inject({ method: "POST", url: "/api/plans", headers: { cookie: admin, origin, host: "localhost:3000" }, payload: { thought: "x" } });
      expect(res.statusCode, `origin ${JSON.stringify(origin)}`).toBe(403);
    }
    const ok = await t.app.inject({ method: "POST", url: "/api/plans", headers: { cookie: admin, origin: "http://localhost:3000", host: "localhost:3000" }, payload: { thought: "x" } });
    expect(ok.statusCode).toBe(200);
  });

  it("guards admin routes however the path is written", async () => {
    for (const url of ["/api/admin/users", "/api/%61dmin/users", "/api/admin/%75sers"]) {
      const anon = await t.app.inject({ method: "GET", url });
      expect(anon.statusCode, url).toBe(401);
    }
    const asAdmin = await t.app.inject({ method: "GET", url: "/api/%61dmin/users", headers: { cookie: admin } });
    expect(asAdmin.statusCode).toBe(200);
    expect(asAdmin.headers["cache-control"]).toBe("no-store");
  });
});

describe("trusted header authentication", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ AUTH_TRUSTED_HEADER: "X-Forwarded-Email", AUTH_TRUSTED_PROXY_TOKEN: "proxy-secret", AUTH_TRUSTED_NAME_HEADER: "X-Forwarded-Name" });
  });
  afterAll(() => t.close());

  it("ignores the header without the proxy token, and creates the user with it", async () => {
    const spoof = await t.app.inject({ method: "GET", url: "/api/auth/me", headers: { "x-forwarded-email": "eve@example.com" } });
    expect(spoof.statusCode).toBe(401);
    const ok = await t.app.inject({ method: "GET", url: "/api/auth/me", headers: { "x-forwarded-email": "pat@example.com", "x-forwarded-name": "Pat Lee", "x-piecewise-proxy-token": "proxy-secret" } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().user).toMatchObject({ email: "pat@example.com", name: "Pat Lee", role: "user", authSource: "trusted-header" });
  });
});

describe("bootstrap administrator", () => {
  it("creates the first admin from the environment", async () => {
    const t = await createTestApp({ BOOTSTRAP_ADMIN_EMAIL: "boot@example.com", BOOTSTRAP_ADMIN_PASSWORD: "bootstrap-password-1" });
    try {
      const res = await t.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "boot@example.com", password: "bootstrap-password-1" } });
      expect(res.statusCode).toBe(200);
      expect(res.json().user).toMatchObject({ role: "app_admin", mustChangePassword: true });
      expect(cookieOf(res)).toContain("piecewise_session=");
    } finally {
      await t.close();
    }
  });
});
