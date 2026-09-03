/**
 * SCIM 2.0 provisioning, driven the way Okta drives it: bearer token, a
 * userName filter before every create, PATCH with and without paths, PUT
 * replacement, group push.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, createUserAs, setupAdmin, type TestApp } from "./helpers.js";

const USER = "urn:ietf:params:scim:schemas:core:2.0:User";
const GROUP = "urn:ietf:params:scim:schemas:core:2.0:Group";
const PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const ERROR = "urn:ietf:params:scim:api:messages:2.0:Error";
const LIST = "urn:ietf:params:scim:api:messages:2.0:ListResponse";

describe("SCIM provisioning", () => {
  let t: TestApp;
  let admin: string;
  let secret: string;
  let tokenId: string;
  const scim = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown, extra: Record<string, string> = {}) =>
    t.app.inject({
      method,
      url: `/api/scim/v2${path}`,
      headers: { authorization: `Bearer ${secret}`, ...(body !== undefined ? { "content-type": "application/scim+json" } : {}), ...extra },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });

  beforeAll(async () => {
    t = await createTestApp({ BASE_URL: "http://localhost:3000", SAML_IDP_SSO_URL: "https://idp.example/sso", SAML_IDP_ISSUER: "http://www.okta.com/exk1", SAML_IDP_CERT: "MIIB", SAML_ADMIN_EMAILS: "boss@example.com" });
    admin = await setupAdmin(t);
    const res = await t.app.inject({ method: "POST", url: "/api/admin/scim/tokens", headers: { cookie: admin }, payload: { label: "Okta" } });
    expect(res.statusCode).toBe(200);
    secret = res.json().secret;
    tokenId = res.json().token.id;
    expect(secret).toMatch(/^pfd_scim_/);
    expect(res.json().token).toMatchObject({ label: "Okta", prefix: secret.slice(0, 13) + "…" });
  });
  afterAll(() => t.close());

  it("requires a bearer token and never accepts the session cookie", async () => {
    const none = await t.app.inject({ method: "GET", url: "/api/scim/v2/Users" });
    expect(none.statusCode).toBe(401);
    expect(none.headers["www-authenticate"]).toContain("Bearer");
    expect(none.headers["content-type"]).toContain("application/scim+json");
    expect(none.json()).toMatchObject({ schemas: [ERROR], status: "401" });
    const wrong = await t.app.inject({ method: "GET", url: "/api/scim/v2/Users", headers: { authorization: "Bearer pcw_scim_nope" } });
    expect(wrong.statusCode).toBe(401);
    const cookie = await t.app.inject({ method: "GET", url: "/api/scim/v2/Users", headers: { cookie: admin } });
    expect(cookie.statusCode).toBe(401);
    const unknown = await scim("GET", "/Nothing");
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().schemas).toEqual([ERROR]);
  });

  it("answers the discovery endpoints", async () => {
    const spc = await scim("GET", "/ServiceProviderConfig");
    expect(spc.statusCode).toBe(200);
    expect(spc.json()).toMatchObject({ patch: { supported: true }, filter: { supported: true }, bulk: { supported: false }, authenticationSchemes: [{ type: "oauthbearertoken" }] });
    const types = await scim("GET", "/ResourceTypes");
    expect(types.json().Resources.map((r: { id: string }) => r.id)).toEqual(["User", "Group"]);
    const schemas = await scim("GET", "/Schemas");
    expect(schemas.json().Resources.map((r: { id: string }) => r.id)).toEqual([USER, GROUP]);
  });

  let danaId: string;
  it("creates a user the way Okta pushes one", async () => {
    const miss = await scim("GET", `/Users?filter=${encodeURIComponent('userName eq "dana@example.com"')}`);
    expect(miss.json()).toMatchObject({ schemas: [LIST], totalResults: 0, Resources: [] });
    const res = await scim("POST", "/Users", {
      schemas: [USER],
      userName: "Dana@Example.com",
      externalId: "00u1dana",
      name: { givenName: "Dana", familyName: "Reyes" },
      emails: [{ primary: true, value: "dana@example.com", type: "work" }],
      displayName: "Dana Reyes",
      locale: "en-US",
      title: "Analyst",
      active: true,
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.headers["content-type"]).toContain("application/scim+json");
    const body = res.json();
    danaId = body.id;
    expect(res.headers.location).toBe(`http://localhost:3000/api/scim/v2/Users/${danaId}`);
    expect(body).toMatchObject({ schemas: [USER], userName: "dana@example.com", externalId: "00u1dana", displayName: "Dana Reyes", name: { givenName: "Dana", familyName: "Reyes", formatted: "Dana Reyes" }, emails: [{ value: "dana@example.com", primary: true }], active: true, groups: [], meta: { resourceType: "User" } });
    const hit = await scim("GET", `/Users?filter=${encodeURIComponent('userName eq "DANA@example.com"')}`);
    expect(hit.json()).toMatchObject({ totalResults: 1, itemsPerPage: 1, startIndex: 1 });
    expect(hit.json().Resources[0].id).toBe(danaId);
    const byExternal = await scim("GET", `/Users?filter=${encodeURIComponent('externalId eq "00u1dana"')}`);
    expect(byExternal.json().totalResults).toBe(1);
    const users = await t.app.inject({ method: "GET", url: "/api/admin/users", headers: { cookie: admin } });
    expect(users.json().users.find((u: { id: string }) => u.id === danaId)).toMatchObject({ authSource: "scim", scimManaged: true, disabled: false, role: "user" });
  });

  it("applies the SAML administrator list and reports conflicts and bad input", async () => {
    const boss = await scim("POST", "/Users", { schemas: [USER], userName: "boss@example.com", name: { givenName: "Bo", familyName: "Ss" } }, { "content-type": "application/json" });
    expect(boss.statusCode).toBe(201);
    const users = await t.app.inject({ method: "GET", url: "/api/admin/users", headers: { cookie: admin } });
    expect(users.json().users.find((u: { email: string }) => u.email === "boss@example.com")).toMatchObject({ role: "app_admin", name: "Bo Ss" });
    const dup = await scim("POST", "/Users", { schemas: [USER], userName: "dana@example.com" });
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toMatchObject({ schemas: [ERROR], scimType: "uniqueness", status: "409" });
    const dupExternal = await scim("POST", "/Users", { schemas: [USER], userName: "someone@example.com", externalId: "00u1dana" });
    expect(dupExternal.statusCode).toBe(409);
    const noEmail = await scim("POST", "/Users", { schemas: [USER], userName: "jdoe" });
    expect(noEmail.statusCode).toBe(400);
    expect(noEmail.json().scimType).toBe("invalidValue");
    const missing = await scim("POST", "/Users", { schemas: [USER] });
    expect(missing.statusCode).toBe(400);
    const badFilter = await scim("GET", `/Users?filter=${encodeURIComponent('title co "x"')}`);
    expect(badFilter.statusCode).toBe(400);
    expect(badFilter.json().scimType).toBe("invalidFilter");
    const badAttr = await scim("GET", `/Users?filter=${encodeURIComponent('title eq "x"')}`);
    expect(badAttr.statusCode).toBe(400);
    const badJson = await t.app.inject({ method: "POST", url: "/api/scim/v2/Users", headers: { authorization: `Bearer ${secret}`, "content-type": "application/scim+json" }, payload: "{not json" });
    expect(badJson.statusCode).toBe(400);
    expect(badJson.json().scimType).toBe("invalidSyntax");
  });

  it("pages through users and reads one by id", async () => {
    const all = await scim("GET", "/Users");
    expect(all.json().totalResults).toBe(3); // the administrator, dana, boss
    const page1 = await scim("GET", "/Users?startIndex=1&count=2");
    expect(page1.json()).toMatchObject({ totalResults: 3, startIndex: 1, itemsPerPage: 2 });
    const page2 = await scim("GET", "/Users?startIndex=3&count=2");
    expect(page2.json()).toMatchObject({ totalResults: 3, startIndex: 3, itemsPerPage: 1 });
    const one = await scim("GET", `/Users/${danaId}`);
    expect(one.statusCode).toBe(200);
    expect(one.json().id).toBe(danaId);
    const none = await scim("GET", "/Users/does-not-exist");
    expect(none.statusCode).toBe(404);
    expect(none.json()).toMatchObject({ schemas: [ERROR], status: "404" });
  });

  it("replaces a user with PUT", async () => {
    const res = await scim("PUT", `/Users/${danaId}`, { schemas: [USER], id: danaId, userName: "dana.reyes@example.com", externalId: "00u1dana", name: { givenName: "Dana", familyName: "Reyes-Ito" }, displayName: "Dana Reyes-Ito", active: true });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ userName: "dana.reyes@example.com", displayName: "Dana Reyes-Ito", name: { familyName: "Reyes-Ito" } });
    const clash = await scim("PUT", `/Users/${danaId}`, { schemas: [USER], userName: "boss@example.com" });
    expect(clash.statusCode).toBe(409);
    const gone = await scim("PUT", "/Users/nope", { schemas: [USER], userName: "x@example.com" });
    expect(gone.statusCode).toBe(404);
  });

  it("deactivates and reactivates with PATCH, ending sessions on deactivation", async () => {
    const sam = await createUserAs(t, admin, "sam@example.com");
    expect((await t.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: sam.cookie } })).statusCode).toBe(200);
    // Okta's deactivation: replace without a path.
    const off = await scim("PATCH", `/Users/${sam.id}`, { schemas: [PATCH], Operations: [{ op: "replace", value: { active: false } }] });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json().active).toBe(false);
    expect((await t.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: sam.cookie } })).statusCode).toBe(401);
    const login = await t.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "sam@example.com", password: sam.password } });
    expect(login.statusCode).toBe(401);
    // Entra-style: a path and a string boolean.
    const on = await scim("PATCH", `/Users/${sam.id}`, { schemas: [PATCH], Operations: [{ op: "Replace", path: "active", value: "True" }] });
    expect(on.json().active).toBe(true);
    const relogin = await t.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "sam@example.com", password: sam.password } });
    expect(relogin.statusCode).toBe(200);
    // Profile updates by path, and attributes this server does not keep are ignored.
    const renamed = await scim("PATCH", `/Users/${sam.id}`, {
      schemas: [PATCH],
      Operations: [
        { op: "replace", path: "name.givenName", value: "Samuel" },
        { op: "replace", path: "name.familyName", value: "Ortiz" },
        { op: "replace", path: "title", value: "Engineer" },
        { op: "add", path: "externalId", value: "00u1sam" },
        { op: "replace", path: 'emails[type eq "work"].value', value: "samuel@example.com" },
      ],
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json()).toMatchObject({ userName: "samuel@example.com", displayName: "Samuel Ortiz", externalId: "00u1sam", name: { givenName: "Samuel", familyName: "Ortiz" } });
    const bad = await scim("PATCH", `/Users/${sam.id}`, { schemas: [PATCH], Operations: [{ op: "explode", path: "active", value: false }] });
    expect(bad.statusCode).toBe(400);
    const noTarget = await scim("PATCH", `/Users/${sam.id}`, { schemas: [PATCH], Operations: [{ op: "remove" }] });
    expect(noTarget.statusCode).toBe(400);
    expect(noTarget.json().scimType).toBe("noTarget");
  });

  let groupId: string;
  it("pushes groups and their members", async () => {
    const miss = await scim("GET", `/Groups?filter=${encodeURIComponent('displayName eq "Analysts"')}`);
    expect(miss.json().totalResults).toBe(0);
    const res = await scim("POST", "/Groups", { schemas: [GROUP], displayName: "Analysts", externalId: "00g1analysts", members: [{ value: danaId, display: "Dana" }] });
    expect(res.statusCode, res.body).toBe(201);
    groupId = res.json().id;
    expect(res.json()).toMatchObject({ schemas: [GROUP], displayName: "Analysts", externalId: "00g1analysts", members: [{ value: danaId, display: "Dana Reyes-Ito" }], meta: { resourceType: "Group" } });
    const hit = await scim("GET", `/Groups?filter=${encodeURIComponent('displayName eq "analysts"')}`);
    expect(hit.json().totalResults).toBe(1);
    const dup = await scim("POST", "/Groups", { schemas: [GROUP], displayName: "analysts" });
    expect(dup.statusCode).toBe(409);
    const badMember = await scim("POST", "/Groups", { schemas: [GROUP], displayName: "Ghosts", members: [{ value: "no-such-user" }] });
    expect(badMember.statusCode).toBe(400);
    const user = await scim("GET", `/Users/${danaId}`);
    expect(user.json().groups).toEqual([{ value: groupId, display: "Analysts", $ref: `http://localhost:3000/api/scim/v2/Groups/${groupId}` }]);
    const withoutMembers = await scim("GET", "/Groups?excludedAttributes=members");
    expect(withoutMembers.json().Resources[0].members).toBeUndefined();
  });

  it("patches group members and names the way Okta does", async () => {
    const boss = (await scim("GET", `/Users?filter=${encodeURIComponent('userName eq "boss@example.com"')}`)).json().Resources[0].id as string;
    const add = await scim("PATCH", `/Groups/${groupId}`, { schemas: [PATCH], Operations: [{ op: "add", path: "members", value: [{ value: boss }] }] });
    expect(add.statusCode, add.body).toBe(200);
    expect(add.json().members.map((m: { value: string }) => m.value).sort()).toEqual([boss, danaId].sort());
    const remove = await scim("PATCH", `/Groups/${groupId}`, { schemas: [PATCH], Operations: [{ op: "remove", path: `members[value eq "${danaId}"]` }] });
    expect(remove.json().members.map((m: { value: string }) => m.value)).toEqual([boss]);
    const rename = await scim("PATCH", `/Groups/${groupId}`, { schemas: [PATCH], Operations: [{ op: "replace", value: { displayName: "Senior Analysts" } }] });
    expect(rename.json().displayName).toBe("Senior Analysts");
    const replaceAll = await scim("PATCH", `/Groups/${groupId}`, { schemas: [PATCH], Operations: [{ op: "replace", path: "members", value: [{ value: danaId }] }] });
    expect(replaceAll.json().members.map((m: { value: string }) => m.value)).toEqual([danaId]);
    const clear = await scim("PATCH", `/Groups/${groupId}`, { schemas: [PATCH], Operations: [{ op: "remove", path: "members" }] });
    expect(clear.json().members).toEqual([]);
    const put = await scim("PUT", `/Groups/${groupId}`, { schemas: [GROUP], displayName: "Analysts", members: [{ value: boss }, { value: danaId }] });
    expect(put.statusCode).toBe(200);
    expect(put.json().members).toHaveLength(2);
    const badPath = await scim("PATCH", `/Groups/${groupId}`, { schemas: [PATCH], Operations: [{ op: "replace", path: "colour", value: "blue" }] });
    expect(badPath.statusCode).toBe(400);
    expect(badPath.json().scimType).toBe("invalidPath");
    const listed = await t.app.inject({ method: "GET", url: "/api/admin/auth", headers: { cookie: admin } });
    expect(listed.json().scim.groups).toEqual([expect.objectContaining({ id: groupId, displayName: "Analysts", members: 2 })]);
  });

  it("deletes users and groups, and records who did what", async () => {
    const delGroup = await scim("DELETE", `/Groups/${groupId}`);
    expect(delGroup.statusCode).toBe(204);
    expect((await scim("GET", `/Groups/${groupId}`)).statusCode).toBe(404);
    const delUser = await scim("DELETE", `/Users/${danaId}`);
    expect(delUser.statusCode).toBe(204);
    expect((await scim("GET", `/Users/${danaId}`)).statusCode).toBe(404);
    expect((await scim("DELETE", `/Users/${danaId}`)).statusCode).toBe(404);
    const users = await t.app.inject({ method: "GET", url: "/api/admin/users", headers: { cookie: admin } });
    expect(users.json().users.some((u: { id: string }) => u.id === danaId)).toBe(false);
    const audit = await t.app.inject({ method: "GET", url: "/api/admin/audit?limit=100", headers: { cookie: admin } });
    const entries = audit.json().entries as Array<{ action: string; actorEmail: string | null; details: { via?: string } | null }>;
    expect(entries.find((e) => e.action === "user.deleted" && e.actorEmail === "scim:Okta")?.details).toMatchObject({ via: "scim" });
    expect(entries.some((e) => e.action === "group.created" && e.actorEmail === "scim:Okta")).toBe(true);
    expect(entries.some((e) => e.action === "scim.token.created")).toBe(true);
  });

  it("applies the configured provisioning roles even when SAML is not set up", async () => {
    // An OIDC-plus-SCIM deployment sets no SAML_IDP_* variables. The role
    // rules still have to work, because they are what the documentation says
    // decides the role of an account the identity provider creates.
    const solo = await createTestApp({ BASE_URL: "", SAML_DEFAULT_ROLE: "integration_admin", SAML_ADMIN_EMAILS: "chief@example.com" });
    try {
      const cookie = await setupAdmin(solo, "root@example.com", "correct-horse-battery");
      const made = await solo.app.inject({ method: "POST", url: "/api/admin/scim/tokens", headers: { cookie }, payload: { label: "Okta" } });
      const key = made.json().secret as string;
      const create = (userName: string) =>
        solo.app.inject({ method: "POST", url: "/api/scim/v2/Users", headers: { authorization: `Bearer ${key}`, "content-type": "application/scim+json" }, payload: JSON.stringify({ schemas: [USER], userName }) });
      expect((await create("chief@example.com")).statusCode).toBe(201);
      expect((await create("everyone@example.com")).statusCode).toBe(201);
      const users = (await solo.app.inject({ method: "GET", url: "/api/admin/users", headers: { cookie } })).json().users as Array<{ email: string; role: string }>;
      expect(users.find((u) => u.email === "chief@example.com")?.role).toBe("app_admin");
      expect(users.find((u) => u.email === "everyone@example.com")?.role).toBe("integration_admin");
      // The SCIM base URL an administrator copies into Okta has to be absolute
      // even when BASE_URL is unset, or it is useless where it gets pasted.
      const info = await solo.app.inject({ method: "GET", url: "/api/admin/auth", headers: { cookie } });
      expect(info.json().scim.baseUrl).toMatch(/^https?:\/\/[^/]+\/api\/scim\/v2$/);
      expect(info.json().methods.saml).toBeNull();
    } finally {
      await solo.close();
    }
  });

  it("stops accepting a revoked token", async () => {
    const info = await t.app.inject({ method: "GET", url: "/api/admin/auth", headers: { cookie: admin } });
    expect(info.json().scim).toMatchObject({ baseUrl: "http://localhost:3000/api/scim/v2", tokens: [expect.objectContaining({ id: tokenId, label: "Okta" })] });
    expect(info.json().scim.tokens[0].lastUsedAt).not.toBeNull();
    expect(info.json().methods).toMatchObject({ local: true, saml: { enforced: false, entityId: "http://localhost:3000/api/auth/saml/metadata", acsUrl: "http://localhost:3000/api/auth/saml/callback" } });
    const revoke = await t.app.inject({ method: "DELETE", url: `/api/admin/scim/tokens/${tokenId}`, headers: { cookie: admin } });
    expect(revoke.statusCode).toBe(200);
    expect((await scim("GET", "/Users")).statusCode).toBe(401);
    expect((await t.app.inject({ method: "DELETE", url: `/api/admin/scim/tokens/${tokenId}`, headers: { cookie: admin } })).statusCode).toBe(404);
  });
});
