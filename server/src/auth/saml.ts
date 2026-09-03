/**
 * SAML 2.0 sign-in (HTTP-Redirect request, HTTP-POST response) through
 * node-saml. Written against Okta, works with any SAML 2.0 identity provider.
 *
 * Two pieces of state live in the database rather than in cookies, because
 * the identity provider posts the response from its own origin and a
 * SameSite=Lax cookie would not travel with that request:
 *
 * - `saml_requests`: ids of AuthnRequests we issued, so a response must answer
 *   one of them (InResponseTo). This is node-saml's cache provider.
 * - `saml_flows`: where to send the person afterwards, keyed by the RelayState
 *   we put in the request.
 */
import { SAML, ValidateInResponseTo, type CacheItem, type CacheProvider, type Profile } from "@node-saml/node-saml";
import type { Config, SamlConfig } from "../config.js";
import { token } from "../crypto.js";
import type { Db } from "../db/index.js";
import { now } from "../db/index.js";

const REQUEST_TTL_MS = 10 * 60_000;
const FLOW_TTL_MS = 15 * 60_000;

export interface SamlIdentity {
  nameId: string;
  nameIdFormat: string | null;
  email: string;
  name: string;
  givenName: string | undefined;
  familyName: string | undefined;
  groups: string[];
  /** True when the response answered a request we issued; false for IdP-initiated sign-in. */
  solicited: boolean;
  redirectTo: string | undefined;
}

/** Only a same-site path: one leading slash, no backslashes, no whitespace. */
export function safeRedirect(value: string | undefined | null): string | undefined {
  return value && /^\/(?![\/\\])[^\s\\]*$/.test(value) ? value : undefined;
}

class DbCacheProvider implements CacheProvider {
  constructor(private db: Db) {}
  private purge() {
    this.db.prepare("DELETE FROM saml_requests WHERE created_at < ?").run(new Date(Date.now() - REQUEST_TTL_MS).toISOString());
  }
  async saveAsync(key: string, value: string): Promise<CacheItem | null> {
    this.purge();
    const existing = this.db.prepare("SELECT 1 FROM saml_requests WHERE id = ?").get(key);
    if (existing) return null;
    const createdAt = new Date();
    this.db.prepare("INSERT INTO saml_requests (id, value, created_at) VALUES (?, ?, ?)").run(key, value, createdAt.toISOString());
    return { value, createdAt: createdAt.getTime() };
  }
  async getAsync(key: string): Promise<string | null> {
    const row = this.db.prepare("SELECT value, created_at FROM saml_requests WHERE id = ?").get(key) as { value: string; created_at: string } | undefined;
    if (!row) return null;
    if (new Date(row.created_at).getTime() + REQUEST_TTL_MS < Date.now()) {
      this.db.prepare("DELETE FROM saml_requests WHERE id = ?").run(key);
      return null;
    }
    return row.value;
  }
  async removeAsync(key: string | null): Promise<string | null> {
    if (!key) return null;
    const changed = this.db.prepare("DELETE FROM saml_requests WHERE id = ?").run(key).changes;
    return changed ? key : null;
  }
}

export class Saml {
  private client: SAML | null = null;
  constructor(
    private db: Db,
    private app: Config,
  ) {}

  get enabled(): boolean {
    return !!this.app.auth.saml;
  }
  get enforced(): boolean {
    return !!this.app.auth.saml?.enforce;
  }
  get settings(): SamlConfig {
    const s = this.app.auth.saml;
    if (!s) throw new Error("SAML is not configured.");
    return s;
  }
  get callbackUrl(): string {
    return new URL("/api/auth/saml/callback", this.app.baseUrl).toString();
  }
  get metadataUrl(): string {
    return new URL("/api/auth/saml/metadata", this.app.baseUrl).toString();
  }
  get entityId(): string {
    return this.settings.spEntityId;
  }

  private saml(): SAML {
    if (this.client) return this.client;
    const s = this.settings;
    this.client = new SAML({
      callbackUrl: this.callbackUrl,
      entryPoint: s.entryPoint,
      issuer: s.spEntityId,
      audience: s.spEntityId,
      idpIssuer: s.idpIssuer,
      idpCert: s.idpCerts,
      identifierFormat: s.nameIdFormat,
      wantAssertionsSigned: true,
      wantAuthnResponseSigned: s.wantResponseSigned,
      acceptedClockSkewMs: s.clockSkewMs,
      validateInResponseTo: s.allowIdpInitiated ? ValidateInResponseTo.ifPresent : ValidateInResponseTo.always,
      requestIdExpirationPeriodMs: REQUEST_TTL_MS,
      cacheProvider: new DbCacheProvider(this.db),
      disableRequestedAuthnContext: true,
      signatureAlgorithm: "sha256",
      digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
      ...(s.spPrivateKey && s.spCert ? { privateKey: s.spPrivateKey, publicCert: s.spCert, decryptionPvk: s.spPrivateKey } : {}),
    });
    return this.client;
  }

  /** Service-provider metadata XML for the identity provider's administrator. */
  metadata(): string {
    const s = this.settings;
    return this.saml().generateServiceProviderMetadata(s.spCert ?? null, s.spCert ?? null);
  }

  /** Starts a flow. Returns the identity provider URL to redirect to. */
  async start(redirectTo: string | undefined): Promise<string> {
    const flowId = token(24);
    this.db.prepare("DELETE FROM saml_flows WHERE created_at < ?").run(new Date(Date.now() - FLOW_TTL_MS).toISOString());
    this.db.prepare("INSERT INTO saml_flows (id, redirect_to, created_at) VALUES (?, ?, ?)").run(flowId, redirectTo ?? null, now());
    return this.saml().getAuthorizeUrlAsync(flowId, undefined, {});
  }

  /** Validates a posted response and returns the identity the provider vouched for. */
  async finish(body: { SAMLResponse: string; RelayState?: string }): Promise<SamlIdentity> {
    const { profile } = await this.saml().validatePostResponseAsync({ SAMLResponse: body.SAMLResponse, ...(body.RelayState ? { RelayState: body.RelayState } : {}) });
    if (!profile || !profile.nameID) throw new Error("The identity provider returned no identity.");
    const s = this.settings;
    // node-saml checks the issuer of logout messages only; a sign-in response
    // signed with the right key but naming another issuer is still refused.
    if (profile.issuer !== s.idpIssuer) throw new Error(`Unknown SAML issuer: ${profile.issuer}`);
    const solicited = !!inResponseTo(profile);
    let redirectTo: string | undefined;
    if (body.RelayState) {
      const flow = this.db.prepare("SELECT redirect_to FROM saml_flows WHERE id = ?").get(body.RelayState) as { redirect_to: string | null } | undefined;
      if (flow) {
        this.db.prepare("DELETE FROM saml_flows WHERE id = ?").run(body.RelayState);
        redirectTo = safeRedirect(flow.redirect_to);
      } else if (!solicited) {
        // IdP-initiated: Okta sends whatever "Default RelayState" is configured; honour it only as a same-site path.
        redirectTo = safeRedirect(body.RelayState);
      }
    }
    const attrs = attributesOf(profile);
    const first = (name: string) => attrs[name]?.[0];
    const email = (first(s.attributes.email) ?? (typeof profile.email === "string" ? profile.email : undefined) ?? (profile.nameID.includes("@") ? profile.nameID : undefined))?.trim().toLowerCase();
    if (!email || !email.includes("@")) throw new Error(`The identity provider did not share an email address. Ask your administrator to send it as the "${s.attributes.email}" attribute.`);
    const givenName = first(s.attributes.firstName)?.trim() || undefined;
    const familyName = first(s.attributes.lastName)?.trim() || undefined;
    const name = first(s.attributes.name)?.trim() || [givenName, familyName].filter(Boolean).join(" ") || email.split("@")[0]!;
    return {
      nameId: profile.nameID,
      nameIdFormat: profile.nameIDFormat ?? null,
      email,
      name,
      givenName,
      familyName,
      groups: attrs[s.attributes.groups] ?? [],
      solicited,
      redirectTo,
    };
  }
}

function inResponseTo(profile: Profile): string | undefined {
  const assertion = profile.getAssertion?.() as { Subject?: Array<{ SubjectConfirmation?: Array<{ SubjectConfirmationData?: Array<{ $?: { InResponseTo?: string } }> }> }> } | undefined;
  const v = assertion?.Subject?.[0]?.SubjectConfirmation?.[0]?.SubjectConfirmationData?.[0]?.$?.InResponseTo;
  if (v) return v;
  const xml = profile.getSamlResponseXml?.() ?? "";
  const m = /<(?:[\w-]+:)?Response\b[^>]*\sInResponseTo="([^"]+)"/.exec(xml);
  return m?.[1];
}

/** Every attribute as a list of strings; values with nested XML are dropped. */
function attributesOf(profile: Profile): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const raw = (profile.attributes ?? {}) as Record<string, unknown>;
  for (const [name, value] of Object.entries(raw)) {
    const list = (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === "string" && v.length > 0);
    if (list.length) out[name] = list;
  }
  return out;
}
