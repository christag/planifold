# Security policy

Piecewise is a planning tool. It stores plans, user accounts, sessions, and AI provider API keys. It does not run automations or hold credentials for the systems its plugins describe. Even so, a bug in authentication, session handling, role checks, or key storage matters. Please report it privately.

## Reporting a vulnerability

Do not open a public issue for a security bug.

Use GitHub Security Advisories for the repository `christag/piecewise`:

```
https://github.com/christag/piecewise/security/advisories/new
```

Include what you can of the following:

- The version or commit you tested (`VERSION` in `server/src/config.ts`, or the image tag from `ghcr.io/christag/piecewise`).
- How Piecewise was configured: which sign-in methods were on (`AUTH_LOCAL`, `OIDC_*`, `AUTH_TRUSTED_HEADER`), whether it sat behind a proxy (`TRUST_PROXY`), and which AI provider was configured.
- Steps to reproduce, with requests and responses where relevant.
- The impact as you understand it: which role gains what, or which data is exposed.
- Whether you found it in the server, the web app, a plugin manifest, or a dependency.

## What to expect

This is an open-source project maintained on a best-effort basis. There is no security team and no guaranteed response time. The aim is to acknowledge a report within a week and to fix confirmed issues in `main` as soon as practical. You will be credited in the advisory unless you ask not to be.

## Supported versions

Only the latest commit on `main` is supported. There are no maintained release branches. Fixes land in `main` and in the `latest` container image built from it.

## Areas worth attention

- Password storage: scrypt (`server/src/crypto.ts`).
- Sessions: random cookie tokens stored in SQLite, `httpOnly`, `sameSite=lax` (`server/src/auth/session.ts`).
- OpenID Connect: authorization code with PKCE and state, tested only against a mock provider (`server/src/auth/oidc.ts`).
- Trusted-header sign-in: the `X-Piecewise-Proxy-Token` check that stops header spoofing (`server/src/auth/plugin.ts`).
- API keys at rest: AES-256-GCM with a key derived from `APP_SECRET` (`server/src/crypto.ts`).
- Role checks on admin and integration routes (`server/src/admin/`).
- Plugin manifest loading and overrides (`server/src/plugins/registry.ts`, `shared/src/manifest.ts`).
- Prompt handling for the AI helper, including how organization guidance and plan text reach the model (`server/src/helper/`).

## Out of scope

- Findings that require a compromised `APP_SECRET`, database file, or host.
- Deployments that set `AUTH_TRUSTED_HEADER` without `AUTH_TRUSTED_PROXY_TOKEN` and expose the port directly. The `.env.example` file explains why the token is needed.
- Rate limiting thresholds. The server applies a fixed limit of 600 requests per minute per client; that is a default, not a security boundary.
