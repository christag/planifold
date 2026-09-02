/**
 * OpenID Connect sign-in (authorization code + PKCE) through openid-client.
 * Works with Entra ID, Okta, Google, Keycloak, Authentik and other compliant
 * providers. The flow state lives in the database, bound to a short-lived
 * cookie, so several app instances can share one database.
 */
import * as client from "openid-client";
import type { Config } from "../config.js";
import type { Db } from "../db/index.js";
import { now } from "../db/index.js";
import { token } from "../crypto.js";

export class Oidc {
  private config: client.Configuration | null = null;
  constructor(
    private db: Db,
    private app: Config,
  ) {}

  get enabled(): boolean {
    return !!this.app.auth.oidc;
  }

  get redirectUri(): string {
    return new URL("/api/auth/oidc/callback", this.app.baseUrl).toString();
  }

  private async configuration(): Promise<client.Configuration> {
    if (this.config) return this.config;
    const o = this.app.auth.oidc!;
    const allowHttp = o.issuer.startsWith("http://");
    this.config = await client.discovery(new URL(o.issuer), o.clientId, o.clientSecret || undefined, undefined, allowHttp ? { execute: [client.allowInsecureRequests] } : undefined);
    return this.config;
  }

  /** Starts a flow. Returns the provider URL to redirect to and the flow id to set as a cookie. */
  async start(redirectTo: string | undefined): Promise<{ url: string; flowId: string }> {
    const cfg = await this.configuration();
    const codeVerifier = client.randomPKCECodeVerifier();
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
    const state = client.randomState();
    const nonce = client.randomNonce();
    const flowId = token(24);
    this.db.prepare("DELETE FROM oidc_flows WHERE created_at < ?").run(new Date(Date.now() - 15 * 60_000).toISOString());
    this.db.prepare("INSERT INTO oidc_flows (id, state, nonce, code_verifier, redirect_to, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(flowId, state, nonce, codeVerifier, redirectTo ?? null, now());
    const url = client.buildAuthorizationUrl(cfg, {
      redirect_uri: this.redirectUri,
      scope: this.app.auth.oidc!.scopes,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state,
      nonce,
    });
    return { url: url.toString(), flowId };
  }

  /** Finishes a flow. Returns the identity the provider vouched for. */
  async finish(flowId: string, currentUrl: URL): Promise<{ sub: string; email: string; name: string; emailVerified: boolean | undefined; redirectTo: string | undefined }> {
    const flow = this.db.prepare("SELECT * FROM oidc_flows WHERE id = ?").get(flowId) as
      | { id: string; state: string; nonce: string; code_verifier: string; redirect_to: string | null }
      | undefined;
    if (!flow) throw new Error("This sign-in attempt expired. Start again.");
    this.db.prepare("DELETE FROM oidc_flows WHERE id = ?").run(flowId);
    const cfg = await this.configuration();
    const tokens = await client.authorizationCodeGrant(cfg, currentUrl, {
      pkceCodeVerifier: flow.code_verifier,
      expectedState: flow.state,
      expectedNonce: flow.nonce,
      idTokenExpected: true,
    });
    const claims = tokens.claims();
    if (!claims) throw new Error("The identity provider returned no identity.");
    let email = typeof claims.email === "string" ? claims.email : undefined;
    let name = typeof claims.name === "string" ? claims.name : undefined;
    let emailVerified = typeof claims.email_verified === "boolean" ? claims.email_verified : undefined;
    if (!email || !name) {
      try {
        const info = await client.fetchUserInfo(cfg, tokens.access_token, claims.sub);
        email ??= typeof info.email === "string" ? info.email : undefined;
        name ??= typeof info.name === "string" ? info.name : undefined;
        emailVerified ??= typeof info.email_verified === "boolean" ? info.email_verified : undefined;
      } catch {
        // Some providers have no userinfo endpoint; the id token has to be enough.
      }
    }
    if (!email) throw new Error("The identity provider did not share an email address. Ask your administrator to add the email scope.");
    return { sub: claims.sub, email: email.toLowerCase(), name: name ?? email.split("@")[0]!, emailVerified, redirectTo: flow.redirect_to ?? undefined };
  }
}
