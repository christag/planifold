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
  };
  bootstrapAdmin: { email: string; password: string; name: string } | undefined;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const env = (str("NODE_ENV", "development") as Config["env"]) || "development";
  const dataDir = resolve(str("DATA_DIR", overrides.dataDir ?? join(process.cwd(), "data")));
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const baseUrl = validBaseUrl(str("BASE_URL"));
  const role = (v: string) => (["user", "integration_admin", "app_admin"].includes(v) ? (v as "user") : "user");

  const oidcIssuer = str("OIDC_ISSUER");
  const trustedHeader = str("AUTH_TRUSTED_HEADER");

  const config: Config = {
    env,
    host: str("HOST", "0.0.0.0"),
    port: int("PORT", 3000),
    baseUrl,
    dataDir,
    dbPath: str("DB_PATH", join(dataDir, "piecewise.sqlite")),
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
    },
    bootstrapAdmin: str("BOOTSTRAP_ADMIN_EMAIL")
      ? { email: str("BOOTSTRAP_ADMIN_EMAIL").toLowerCase(), password: str("BOOTSTRAP_ADMIN_PASSWORD"), name: str("BOOTSTRAP_ADMIN_NAME", "Administrator") }
      : undefined,
    ...overrides,
  };
  if (config.auth.oidc && !config.auth.oidc.clientId) throw new Error("OIDC_ISSUER is set but OIDC_CLIENT_ID is missing");
  if (config.auth.oidc && !config.baseUrl) throw new Error("OIDC needs BASE_URL so the callback address is known");
  return config;
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
