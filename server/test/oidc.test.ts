import { OAuth2Server } from "oauth2-mock-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cookieOf, createTestApp, type TestApp } from "./helpers.js";

describe("OpenID Connect sign-in", () => {
  let idp: OAuth2Server;
  let t: TestApp;
  const claims: { email: string; name: string; sub: string; email_verified?: boolean } = { email: "dana@example.com", name: "Dana Reyes", sub: "dana-sub-1" };
  beforeAll(async () => {
    idp = new OAuth2Server();
    await idp.issuer.keys.generate("RS256");
    await idp.start(0, "127.0.0.1");
    idp.service.on("beforeTokenSigning", (token) => {
      Object.assign(token.payload, claims);
    });
    t = await createTestApp({
      OIDC_ISSUER: idp.issuer.url!,
      OIDC_CLIENT_ID: "planifold",
      OIDC_CLIENT_SECRET: "secret",
      OIDC_ADMIN_EMAILS: "dana@example.com",
      BASE_URL: "http://localhost:3000",
    });
  });
  afterAll(async () => {
    await t.close();
    await idp.stop();
  });

  it("advertises single sign-on", async () => {
    const res = await t.app.inject({ method: "GET", url: "/api/auth/config" });
    expect(res.json().oidc).toEqual({ label: "Sign in with single sign-on" });
  });

  it("completes the authorization code flow and creates the user", async () => {
    const start = await t.app.inject({ method: "GET", url: "/api/auth/oidc/start?redirect=/plans/abc" });
    expect(start.statusCode).toBe(302);
    const flowCookie = cookieOf(start);
    const authUrl = new URL(start.headers.location as string);
    expect(authUrl.origin).toBe(new URL(idp.issuer.url!).origin);
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");

    const idpRes = await fetch(authUrl, { redirect: "manual" });
    expect(idpRes.status).toBe(302);
    const back = new URL(idpRes.headers.get("location")!);
    expect(back.pathname).toBe("/api/auth/oidc/callback");

    const cb = await t.app.inject({ method: "GET", url: back.pathname + back.search, headers: { cookie: flowCookie } });
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe("/plans/abc");
    const session = cookieOf(cb);
    expect(session).toContain("planifold_session=");

    const me = await t.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: session } });
    expect(me.json().user).toMatchObject({ email: "dana@example.com", name: "Dana Reyes", role: "app_admin", authSource: "oidc" });
  });

  async function run(redirect?: string) {
    const start = await t.app.inject({ method: "GET", url: `/api/auth/oidc/start${redirect ? `?redirect=${encodeURIComponent(redirect)}` : ""}` });
    const flowCookie = cookieOf(start);
    const idpRes = await fetch(new URL(start.headers.location as string), { redirect: "manual" });
    const back = new URL(idpRes.headers.get("location")!);
    return t.app.inject({ method: "GET", url: back.pathname + back.search, headers: { cookie: flowCookie } });
  }

  it("ignores redirect targets that could leave the site", async () => {
    for (const bad of ["/\\evil.example", "//evil.example", "https://evil.example", "/x\ty", "/ok\\bad"]) {
      const cb = await run(bad);
      expect(cb.statusCode).toBe(302);
      expect(cb.headers.location, bad).toBe("/");
    }
  });

  it("keeps the same account across sign-ins and refuses an unverified email for an existing account", async () => {
    const before = await run();
    expect(before.headers.location).toBe("/");
    const me = await t.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: cookieOf(before) } });
    const id = me.json().user.id;
    // Same subject, changed display name: same account.
    claims.name = "Dana R.";
    const again = await run();
    const me2 = await t.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: cookieOf(again) } });
    expect(me2.json().user.id).toBe(id);
    // A different subject presenting the same, unverified email is turned away.
    claims.sub = "attacker-sub";
    claims.email_verified = false;
    const spoof = await run();
    expect(spoof.headers.location).toContain("/login?error=");
    expect(decodeURIComponent(spoof.headers.location as string)).toContain("unverified");
    // A different subject with a verified email but an already-linked account is also turned away.
    claims.email_verified = true;
    const collide = await run();
    expect(decodeURIComponent(collide.headers.location as string)).toContain("different single sign-on identity");
    claims.sub = "dana-sub-1";
    delete claims.email_verified;
  });

  it("rejects a callback without a matching flow", async () => {
    const cb = await t.app.inject({ method: "GET", url: "/api/auth/oidc/callback?code=x&state=y" });
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toContain("/login?error=");
  });
});
