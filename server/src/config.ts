/**
 * Runtime configuration, read once from the environment.
 * Every value has a safe default so `npm start` works with no setup.
 * See docs/deploy.md for the full list.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function str(name: string, fallback = ""): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}
function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}
function int(name: string, fallback: number): number {
  const v = Number.parseInt(str(name), 10);
  return Number.isFinite(v) ? v : fallback;
}
function firstExisting(candidates: string[]): string | undefined {
  return candidates.find((c) => existsSync(c));
}
/** `NAME` inline, or the contents of the file named by `NAME_FILE`. Literal `\n` in an inline value is unescaped so PEM blocks survive env files. */
function strOrFile(name: string): string {
  const inline = str(name);
  if (inline) return inline.replace(/\\n/g, "\n").trim();
  const file = str(`${name}_FILE`);
  if (!file) return "";
  if (!existsSync(file)) throw new Error(`${name}_FILE points at ${file}, which does not exist`);
  return readFileSync(file, "utf8").trim();
}
function list(name: string): string[] {
  return str(name)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export type RoleName = "user" | "integration_admin" | "app_admin";

export interface SamlConfig {
  /** The identity provider's single sign-on URL (Okta: "Identity Provider Single Sign-On URL"). */
  entryPoint: string;
  /** The identity provider's entity id (Okta: "Identity Provider Issuer"). */
  idpIssuer: string;
  /** One or more X.509 signing certificates, PEM or bare base64. */
  idpCerts: string[];
  /** This service provider's entity id / audience. */
  spEntityId: string;
  /** Optional key pair for signing requests and decrypting assertions. */
  spPrivateKey: string | undefined;
  spCert: string | undefined;
  /** NameID format to request; null lets the provider choose. */
  nameIdFormat: string | null;
  wantResponseSigned: boolean;
  allowIdpInitiated: boolean;
  clockSkewMs: number;
  buttonLabel: string;
  attributes: { email: string; name: string; firstName: string; lastName: string; groups: string };
  /** When true, SAML is the only way in: password, OIDC, and trusted-header sign-in are off. */
  enforce: boolean;
}

export interface Config {
  env: "production" | "development" | "test";
  host: string;
  port: number;
  baseUrl: string | undefined;
  dataDir: string;
  dbPath: string;
  appSecret: string;
  builtinPluginsDir: string | undefined;
  extraPluginsDir: string | undefined;
  webDistDir: string | undefined;
  trustProxy: boolean;
  secureCookies: boolean;
  sessionDays: number;
  logLevel: string;
  auth: {
    local: boolean;
    oidc:
      | undefined
      | {
          issuer: string;
          clientId: string;
          clientSecret: string;
          scopes: string;
          buttonLabel: string;
          defaultRole: "user" | "integration_admin" | "app_admin";
          adminEmails: string[];
        };
    trustedHeader:
      | undefined
      | {
          emailHeader: string;
          nameHeader: string | undefined;
          proxyToken: string | undefined;
          defaultRole: "user" | "integration_admin" | "app_admin";
        };
    saml: SamlConfig | undefined;
    /**
     * How an account gets its role when an identity provider creates it,
     * whether that happens at SAML sign-in or ahead of time over SCIM. Read
     * unconditionally, so a deployment that provisions over SCIM but signs in
     * some other way still gets the roles it configured.
     */
    provisioning: { defaultRole: RoleName; adminEmails: string[]; adminGroups: string[] };
  };
  bootstrapAdmin: { email: string; password: string; name: string } | undefined;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const env = (str("NODE_ENV", "development") as Config["env"]) || "development";
  const dataDir = resolve(str("DATA_DIR", overrides.dataDir ?? join(process.cwd(), "data")));
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const baseUrl = validBaseUrl(str("BASE_URL"));
  const role = (v: string): RoleName => (["user", "integration_admin", "app_admin"].includes(v) ? (v as RoleName) : "user");

  const oidcIssuer = str("OIDC_ISSUER");
  const trustedHeader = str("AUTH_TRUSTED_HEADER");
  const saml = loadSaml(baseUrl);

  const config: Config = {
    env,
    host: str("HOST", "0.0.0.0"),
    port: int("PORT", 3000),
    baseUrl,
    dataDir,
    dbPath: str("DB_PATH", defaultDbPath(dataDir)),
    appSecret: str("APP_SECRET") || loadOrCreateSecret(dataDir),
    builtinPluginsDir:
      str("BUILTIN_PLUGINS_DIR") ||
      firstExisting([join(here, "..", "..", "plugins"), join(here, "..", "plugins"), join(process.cwd(), "plugins")]),
    extraPluginsDir: str("PLUGINS_DIR") || undefined,
    webDistDir: str("WEB_DIST_DIR") || firstExisting([join(here, "..", "..", "web", "dist"), join(here, "..", "web"), join(process.cwd(), "web", "dist")]),
    trustProxy: bool("TRUST_PROXY", false),
    secureCookies: bool("SECURE_COOKIES", !!baseUrl && baseUrl.startsWith("https://")),
    sessionDays: int("SESSION_DAYS", 14),
    logLevel: str("LOG_LEVEL", env === "test" ? "silent" : "info"),
    auth: {
      local: bool("AUTH_LOCAL", true),
      oidc: oidcIssuer
        ? {
            issuer: oidcIssuer,
            clientId: str("OIDC_CLIENT_ID"),
            clientSecret: str("OIDC_CLIENT_SECRET"),
            scopes: str("OIDC_SCOPES", "openid email profile"),
            buttonLabel: str("OIDC_BUTTON_LABEL", "Sign in with single sign-on"),
            defaultRole: role(str("OIDC_DEFAULT_ROLE", "user")),
            adminEmails: str("OIDC_ADMIN_EMAILS")
              .split(",")
              .map((s) => s.trim().toLowerCase())
              .filter(Boolean),
          }
        : undefined,
      trustedHeader: trustedHeader
        ? {
            emailHeader: trustedHeader.toLowerCase(),
            nameHeader: str("AUTH_TRUSTED_NAME_HEADER").toLowerCase() || undefined,
            proxyToken: str("AUTH_TRUSTED_PROXY_TOKEN") || undefined,
            defaultRole: role(str("AUTH_TRUSTED_DEFAULT_ROLE", "user")),
          }
        : undefined,
      saml,
      provisioning: {
        defaultRole: role(str("SAML_DEFAULT_ROLE", "user")),
        adminEmails: list("SAML_ADMIN_EMAILS").map((s) => s.toLowerCase()),
        adminGroups: list("SAML_ADMIN_GROUPS"),
      },
    },
    bootstrapAdmin: str("BOOTSTRAP_ADMIN_EMAIL")
      ? { email: str("BOOTSTRAP_ADMIN_EMAIL").toLowerCase(), password: str("BOOTSTRAP_ADMIN_PASSWORD"), name: str("BOOTSTRAP_ADMIN_NAME", "Administrator") }
      : undefined,
    ...overrides,
  };
  if (config.auth.oidc && !config.auth.oidc.clientId) throw new Error("OIDC_ISSUER is set but OIDC_CLIENT_ID is missing");
  if (config.auth.oidc && !config.baseUrl) throw new Error("OIDC needs BASE_URL so the callback address is known");
  if (config.auth.saml && !config.baseUrl) throw new Error("SAML needs BASE_URL so the assertion consumer address is known");
  if (config.auth.saml?.enforce) {
    // Enforcement means SAML is the only door. The other methods are switched
    // off here so that every route, hook, and the sign-in page agree.
    config.auth.local = false;
    config.auth.oidc = undefined;
    config.auth.trustedHeader = undefined;
  }
  return config;
}

/** Reads SAML_* and returns undefined when none of the three required values is set. */
function loadSaml(baseUrl: string | undefined): SamlConfig | undefined {
  const entryPoint = str("SAML_IDP_SSO_URL");
  const idpIssuer = str("SAML_IDP_ISSUER");
  const idpCert = strOrFile("SAML_IDP_CERT");
  const enforce = bool("SAML_ENFORCE", false);
  if (!entryPoint && !idpIssuer && !idpCert) {
    if (enforce) throw new Error("SAML_ENFORCE is set but SAML is not configured (SAML_IDP_SSO_URL, SAML_IDP_ISSUER, SAML_IDP_CERT)");
    return undefined;
  }
  const missing = [!entryPoint && "SAML_IDP_SSO_URL", !idpIssuer && "SAML_IDP_ISSUER", !idpCert && "SAML_IDP_CERT (or SAML_IDP_CERT_FILE)"].filter(Boolean);
  if (missing.length) throw new Error(`SAML is partly configured; missing ${missing.join(", ")}`);
  try {
    new URL(entryPoint);
  } catch {
    throw new Error("SAML_IDP_SSO_URL must be an absolute URL");
  }
  const spPrivateKey = strOrFile("SAML_SP_PRIVATE_KEY") || undefined;
  const spCert = strOrFile("SAML_SP_CERT") || undefined;
  if (!!spPrivateKey !== !!spCert) throw new Error("SAML_SP_PRIVATE_KEY and SAML_SP_CERT must be set together");
  const nameIdFormat = str("SAML_NAMEID_FORMAT");
  return {
    entryPoint,
    idpIssuer,
    idpCerts: splitCerts(idpCert),
    spEntityId: str("SAML_SP_ENTITY_ID") || (baseUrl ? `${baseUrl}/api/auth/saml/metadata` : ""),
    spPrivateKey,
    spCert,
    nameIdFormat: nameIdFormat || null,
    wantResponseSigned: bool("SAML_WANT_RESPONSE_SIGNED", true),
    allowIdpInitiated: bool("SAML_ALLOW_IDP_INITIATED", false),
    clockSkewMs: Math.max(0, int("SAML_CLOCK_SKEW_SECONDS", 120)) * 1000,
    buttonLabel: str("SAML_BUTTON_LABEL", "Sign in with SAML single sign-on"),
    attributes: {
      email: str("SAML_ATTR_EMAIL", "email"),
      name: str("SAML_ATTR_NAME", "name"),
      firstName: str("SAML_ATTR_FIRST_NAME", "firstName"),
      lastName: str("SAML_ATTR_LAST_NAME", "lastName"),
      groups: str("SAML_ATTR_GROUPS", "groups"),
    },
    enforce,
  };
}

/** One PEM bundle may hold several certificates (key rotation); a bare base64 body is passed through as is. */
function splitCerts(raw: string): string[] {
  const blocks = raw.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
  return blocks && blocks.length ? blocks : [raw];
}

/**
 * The database file. New installs get `planifold.sqlite`. An install from
 * before the rename keeps using its existing `piecewise.sqlite` rather than
 * silently starting empty beside it; set DB_PATH to override either way.
 */
function defaultDbPath(dataDir: string): string {
  const current = join(dataDir, "planifold.sqlite");
  const legacy = join(dataDir, "piecewise.sqlite");
  return !existsSync(current) && existsSync(legacy) ? legacy : current;
}

/** Accepts only absolute http(s) URLs; anything else is treated as unset. */
function validBaseUrl(raw: string): string | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    return u.origin + (u.pathname === "/" ? "" : u.pathname.replace(/\/$/, ""));
  } catch {
    return undefined;
  }
}

/**
 * The app secret encrypts API keys at rest. If none is provided we generate
 * one and keep it next to the database so restarts keep working. Set
 * APP_SECRET explicitly in production so it can be rotated and backed up.
 */
function loadOrCreateSecret(dataDir: string): string {
  const file = join(dataDir, ".app-secret");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  const secret = randomBytes(32).toString("base64url");
  writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

export const VERSION = "0.1.0";
