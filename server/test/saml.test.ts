/**
 * SAML sign-in against a mock identity provider: a self-signed certificate
 * and hand-built, XML-signed responses shaped like Okta's.
 */
import { randomBytes } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { generate } from "selfsigned";
import { SignedXml } from "xml-crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cookieOf, createTestApp, createUserAs, setupAdmin, type TestApp } from "./helpers.js";

const BASE_URL = "http://localhost:3000";
const SP_ENTITY_ID = `${BASE_URL}/api/auth/saml/metadata`;
const ACS_URL = `${BASE_URL}/api/auth/saml/callback`;
const IDP_ISSUER = "http://www.okta.com/exk1test";
const IDP_SSO_URL = "https://dev-1.okta.com/app/piecewise/exk1test/sso/saml";

let pems: { private: string; cert: string };
let otherPems: { private: string; cert: string };

interface AssertionOptions {
  nameId: string;
  nameIdFormat?: string;
  inResponseTo?: string;
  audience?: string;
  issuer?: string;
  attributes?: Record<string, string | string[]>;
  notOnOrAfter?: Date;
  keys?: { private: string; cert: string };
  signAssertion?: boolean;
  signResponse?: boolean;
}

const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const id = () => "_" + randomBytes(16).toString("hex");

function sign(xml: string, elementId: string, keys: { private: string; cert: string }): string {
  const sig = new SignedXml({
    privateKey: keys.private,
    publicCert: keys.cert,
    signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
    canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
  });
  sig.addReference({
    xpath: `//*[@ID='${elementId}']`,
    transforms: ["http://www.w3.org/2000/09/xmldsig#enveloped-signature", "http://www.w3.org/2001/10/xml-exc-c14n#"],
    digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
  });
  sig.computeSignature(xml, { prefix: "ds", location: { reference: `//*[@ID='${elementId}']/*[local-name()='Issuer']`, action: "after" } });
  return sig.getSignedXml();
}

/** Builds a SAML Response the way Okta does: signed assertion inside a signed response. */
function buildResponse(o: AssertionOptions): string {
  const now = new Date();
  const iso = (d: Date) => d.toISOString();
  const notBefore = new Date(now.getTime() - 60_000);
  const notOnOrAfter = o.notOnOrAfter ?? new Date(now.getTime() + 5 * 60_000);
  const issuer = o.issuer ?? IDP_ISSUER;
  const audience = o.audience ?? SP_ENTITY_ID;
  const keys = o.keys ?? pems;
  const inResponseTo = o.inResponseTo ? ` InResponseTo="${o.inResponseTo}"` : "";
  const attrs = Object.entries(o.attributes ?? {})
    .map(([name, value]) => {
      const values = (Array.isArray(value) ? value : [value]).map((v) => `<saml:AttributeValue xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="xs:string">${escapeXml(v)}</saml:AttributeValue>`).join("");
      return `<saml:Attribute Name="${escapeXml(name)}" NameFormat="urn:oasis:names:tc:SAML:2.0:attrname-format:unspecified">${values}</saml:Attribute>`;
    })
    .join("");
  const assertionId = id();
  let assertion =
    `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${assertionId}" IssueInstant="${iso(now)}" Version="2.0">` +
    `<saml:Issuer>${escapeXml(issuer)}</saml:Issuer>` +
    `<saml:Subject><saml:NameID Format="${o.nameIdFormat ?? "urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified"}">${escapeXml(o.nameId)}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="${iso(notOnOrAfter)}" Recipient="${ACS_URL}"${inResponseTo}/></saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${iso(notBefore)}" NotOnOrAfter="${iso(notOnOrAfter)}"><saml:AudienceRestriction><saml:Audience>${escapeXml(audience)}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${iso(now)}" SessionIndex="${assertionId}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
    (attrs ? `<saml:AttributeStatement>${attrs}</saml:AttributeStatement>` : "") +
    `</saml:Assertion>`;
  if (o.signAssertion !== false) assertion = sign(assertion, assertionId, keys);
  const responseId = id();
  let response =
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${responseId}" Version="2.0" IssueInstant="${iso(now)}" Destination="${ACS_URL}"${inResponseTo}>` +
    `<saml:Issuer>${escapeXml(issuer)}</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
    assertion +
    `</samlp:Response>`;
  if (o.signResponse !== false) response = sign(response, responseId, keys);
  return response;
}

async function startFlow(t: TestApp, redirect?: string) {
  const res = await t.app.inject({ method: "GET", url: `/api/auth/saml/start${redirect ? `?redirect=${encodeURIComponent(redirect)}` : ""}` });
  expect(res.statusCode).toBe(302);
  const url = new URL(res.headers.location as string);
  expect(url.origin + url.pathname).toBe(IDP_SSO_URL);
  const relayState = url.searchParams.get("RelayState")!;
  const request = inflateRawSync(Buffer.from(url.searchParams.get("SAMLRequest")!, "base64")).toString("utf8");
  const requestId = /\sID="([^"]+)"/.exec(request)![1]!;
  return { requestId, relayState, request };
}

/** Posts a response the way a browser does after the identity provider's page auto-submits its form. */
function post(t: TestApp, responseXml: string, relayState?: string) {
  const form = new URLSearchParams({ SAMLResponse: Buffer.from(responseXml, "utf8").toString("base64"), ...(relayState ? { RelayState: relayState } : {}) });
  return t.app.inject({ method: "POST", url: "/api/auth/saml/callback", headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://dev-1.okta.com" }, payload: form.toString() });
}

const errorOf = (res: { headers: Record<string, unknown> }) => decodeURIComponent(String(res.headers.location)).replace("/login?error=", "");

const SAML_ENV = () => ({
  BASE_URL,
  SAML_IDP_SSO_URL: IDP_SSO_URL,
  SAML_IDP_ISSUER: IDP_ISSUER,
  SAML_IDP_CERT: pems.cert,
  SAML_ADMIN_EMAILS: "dana@example.com",
  SAML_ADMIN_GROUPS: "Piecewise Admins",
});

beforeAll(async () => {
  [pems, otherPems] = await Promise.all([generate([{ name: "commonName", value: "idp.example" }], { keySize: 2048, algorithm: "sha256" }), generate([{ name: "commonName", value: "other.example" }], { keySize: 2048, algorithm: "sha256" })]);
});

describe("SAML sign-in", () => {
  let t: TestApp;
  let admin: string;
  beforeAll(async () => {
    t = await createTestApp(SAML_ENV());
    // A password administrator, created before anyone signs in through SAML.
    admin = await setupAdmin(t, "root@example.com", "correct-horse-battery");
  });
  afterAll(() => t.close());

  it("advertises SAML and serves service-provider metadata", async () => {
    const cfg = await t.app.inject({ method: "GET", url: "/api/auth/config" });
    expect(cfg.json()).toMatchObject({ saml: { label: "Sign in with SAML single sign-on", enforced: false }, local: true });
    const md = await t.app.inject({ method: "GET", url: "/api/auth/saml/metadata" });
    expect(md.statusCode).toBe(200);
    expect(md.headers["content-type"]).toContain("application/xml");
    expect(md.body).toContain(`entityID="${SP_ENTITY_ID}"`);
    expect(md.body).toContain(`Location="${ACS_URL}"`);
    expect(md.body).toContain("HTTP-POST");
  });

  it("completes an SP-initiated sign-in, maps attributes, and makes the listed email an administrator", async () => {
    const { requestId, relayState, request } = await startFlow(t, "/plans/abc");
    expect(request).toContain(`AssertionConsumerServiceURL="${ACS_URL}"`);
    expect(request).toMatch(new RegExp(`<saml:Issuer[^>]*>${SP_ENTITY_ID}</saml:Issuer>`));
    const res = await post(t, buildResponse({ nameId: "00u1dana", inResponseTo: requestId, attributes: { email: "Dana@Example.com", firstName: "Dana", lastName: "Reyes" } }), relayState);
    expect(res.statusCode, res.body).toBe(302);
    expect(res.headers.location).toBe("/plans/abc");
    const session = cookieOf(res);
    expect(session).toContain("piecewise_session=");
    const me = await t.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: session } });
    expect(me.json().user).toMatchObject({ email: "dana@example.com", name: "Dana Reyes", role: "app_admin", authSource: "saml", scimManaged: false });
  });

  it("refuses a replayed response and a tampered one", async () => {
    const { requestId, relayState } = await startFlow(t);
    const xml = buildResponse({ nameId: "00u1dana", inResponseTo: requestId, attributes: { email: "dana@example.com" } });
    const first = await post(t, xml, relayState);
    expect(first.headers.location).toBe("/");
    const replay = await post(t, xml, relayState);
    expect(errorOf(replay)).toContain("expired or was already used");

    const again = await startFlow(t);
    const signed = buildResponse({ nameId: "00u1dana", inResponseTo: again.requestId, attributes: { email: "dana@example.com" } });
    const tampered = signed.replace("dana@example.com</saml:AttributeValue>", "mallory@example.com</saml:AttributeValue>");
    expect(tampered).not.toBe(signed);
    const res = await post(t, tampered, again.relayState);
    expect(errorOf(res)).toContain("could not be verified");
  });

  it("refuses responses signed by another key, for another audience, from another issuer, or expired", async () => {
    const cases: Array<[Partial<AssertionOptions>, string]> = [
      [{ keys: otherPems }, "could not be verified"],
      [{ audience: "https://other.example/sp" }, "different application"],
      [{ issuer: "http://www.okta.com/exkSomeoneElse" }, "unexpected identity provider"],
      [{ notOnOrAfter: new Date(Date.now() - 10 * 60_000) }, "expired"],
      [{ signAssertion: false }, "could not be verified"],
    ];
    for (const [overrides, message] of cases) {
      const { requestId, relayState } = await startFlow(t);
      const res = await post(t, buildResponse({ nameId: "00u1dana", inResponseTo: requestId, attributes: { email: "dana@example.com" }, ...overrides }), relayState);
      expect(res.statusCode).toBe(302);
      expect(errorOf(res), JSON.stringify(overrides)).toContain(message);
    }
  });

  it("refuses an unsolicited (IdP-initiated) response by default", async () => {
    const res = await post(t, buildResponse({ nameId: "00u1dana", attributes: { email: "dana@example.com" } }));
    expect(errorOf(res)).toContain("must start from Piecewise");
  });

  it("uses the NameID as the email when no attribute is sent, and the email's local part as the name", async () => {
    const { requestId, relayState } = await startFlow(t);
    const res = await post(t, buildResponse({ nameId: "Pat.Lee@example.com", nameIdFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress", inResponseTo: requestId }), relayState);
    expect(res.headers.location).toBe("/");
    const me = await t.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: cookieOf(res) } });
    expect(me.json().user).toMatchObject({ email: "pat.lee@example.com", name: "pat.lee", role: "user" });
  });

  it("makes members of an admin group administrators", async () => {
    const { requestId, relayState } = await startFlow(t);
    const res = await post(t, buildResponse({ nameId: "00u1kim", inResponseTo: requestId, attributes: { email: "kim@example.com", name: "Kim Ito", groups: ["Everyone", "Piecewise Admins"] } }), relayState);
    const me = await t.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: cookieOf(res) } });
    expect(me.json().user).toMatchObject({ email: "kim@example.com", name: "Kim Ito", role: "app_admin" });
  });

  it("links an existing password account by email once, then refuses a different NameID for it", async () => {
    const sam = await createUserAs(t, admin, "sam@example.com");
    const { requestId, relayState } = await startFlow(t);
    const res = await post(t, buildResponse({ nameId: "00u1sam", inResponseTo: requestId, attributes: { email: "sam@example.com" } }), relayState);
    expect(res.headers.location).toBe("/");
    const me = await t.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: cookieOf(res) } });
    expect(me.json().user).toMatchObject({ id: sam.id, email: "sam@example.com", authSource: "saml", role: "user" });

    const other = await startFlow(t);
    const spoof = await post(t, buildResponse({ nameId: "00u1mallory", inResponseTo: other.requestId, attributes: { email: "sam@example.com" } }), other.relayState);
    expect(errorOf(spoof)).toContain("different single sign-on identity");
  });

  it("links a SCIM-provisioned account by external id and decides its role on first sign-in", async () => {
    const tok = await t.app.inject({ method: "POST", url: "/api/admin/scim/tokens", headers: { cookie: admin }, payload: { label: "Okta" } });
    const secret = tok.json().secret as string;
    const created = await t.app.inject({
      method: "POST",
      url: "/api/scim/v2/Users",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/scim+json" },
      payload: JSON.stringify({ schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], userName: "lee@example.com", externalId: "00u1lee", name: { givenName: "Lee", familyName: "Park" }, active: true }),
    });
    expect(created.statusCode).toBe(201);
    // Okta configured to send its user id as the NameID, and a changed email.
    const { requestId, relayState } = await startFlow(t);
    const res = await post(t, buildResponse({ nameId: "00u1lee", inResponseTo: requestId, attributes: { email: "lee.park@example.com", groups: ["Piecewise Admins"] } }), relayState);
    expect(res.headers.location).toBe("/");
    const me = await t.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: cookieOf(res) } });
    expect(me.json().user).toMatchObject({ id: created.json().id, email: "lee@example.com", name: "Lee Park", role: "app_admin", authSource: "saml", scimManaged: true });
  });

  it("rejects a callback without a response body", async () => {
    const res = await t.app.inject({ method: "POST", url: "/api/auth/saml/callback", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "RelayState=x" });
    expect(res.statusCode).toBe(302);
    expect(errorOf(res)).toContain("incomplete response");
  });
});

describe("IdP-initiated SAML sign-in when allowed", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ ...SAML_ENV(), SAML_ALLOW_IDP_INITIATED: "true" });
  });
  afterAll(() => t.close());

  it("accepts an unsolicited response and honours a same-site default RelayState only", async () => {
    const ok = await post(t, buildResponse({ nameId: "00u1dana", attributes: { email: "dana@example.com" } }), "/plans/from-okta");
    expect(ok.statusCode, ok.body).toBe(302);
    expect(ok.headers.location).toBe("/plans/from-okta");
    expect(cookieOf(ok)).toContain("piecewise_session=");
    const off = await post(t, buildResponse({ nameId: "00u1dana", attributes: { email: "dana@example.com" } }), "https://evil.example/");
    expect(off.headers.location).toBe("/");
    // A solicited flow still works and still refuses replays.
    const { requestId, relayState } = await startFlow(t, "/plans/x");
    const xml = buildResponse({ nameId: "00u1dana", inResponseTo: requestId, attributes: { email: "dana@example.com" } });
    expect((await post(t, xml, relayState)).headers.location).toBe("/plans/x");
    expect(errorOf(await post(t, xml, relayState))).toContain("already used");
  });
});

describe("SAML enforcement", () => {
  it("turns the other methods off, ends their sessions, and still signs in through SAML", async () => {
    const before = await createTestApp(SAML_ENV());
    const dir = before.dir;
    let adminCookie: string;
    try {
      adminCookie = await setupAdmin(before);
      expect((await before.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: adminCookie } })).statusCode).toBe(200);
    } finally {
      await before.app.close();
    }
    const t = await createTestApp({ ...SAML_ENV(), DATA_DIR: dir, SAML_ENFORCE: "true" });
    try {
      const cfg = await t.app.inject({ method: "GET", url: "/api/auth/config" });
      expect(cfg.json()).toMatchObject({ needsSetup: false, local: false, oidc: null, trustedHeader: false, saml: { enforced: true } });
      // The password session from before enforcement is gone.
      expect((await t.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: adminCookie! } })).statusCode).toBe(401);
      expect((await t.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@example.com", password: "correct-horse-battery" } })).statusCode).toBe(403);
      expect((await t.app.inject({ method: "POST", url: "/api/auth/setup", payload: { email: "x@example.com", name: "X", password: "another-long-password" } })).statusCode).toBe(403);
      // The same administrator signs in through SAML and keeps the account.
      const { requestId, relayState } = await startFlow(t, "/admin");
      const res = await post(t, buildResponse({ nameId: "00u1admin", inResponseTo: requestId, attributes: { email: "admin@example.com" } }), relayState);
      expect(res.headers.location).toBe("/admin");
      const me = await t.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: cookieOf(res) } });
      expect(me.json().user).toMatchObject({ email: "admin@example.com", role: "app_admin", authSource: "saml" });
      const users = await t.app.inject({ method: "GET", url: "/api/admin/users", headers: { cookie: cookieOf(res) } });
      expect(users.json().users).toHaveLength(1);
    } finally {
      await t.close();
      await before.close();
    }
  });

  it("refuses to start when enforced without SAML configured", async () => {
    await expect(createTestApp({ SAML_ENFORCE: "true" })).rejects.toThrow(/SAML_ENFORCE/);
    await expect(createTestApp({ BASE_URL, SAML_IDP_SSO_URL: IDP_SSO_URL })).rejects.toThrow(/partly configured/);
    await expect(createTestApp({ SAML_IDP_SSO_URL: IDP_SSO_URL, SAML_IDP_ISSUER: IDP_ISSUER, SAML_IDP_CERT: pems.cert })).rejects.toThrow(/BASE_URL/);
  });
});
