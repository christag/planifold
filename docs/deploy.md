# Deploying Piecewise

Piecewise is one Node.js process with one SQLite file. There is no database server, no queue, and no cache to run. This document covers running it in a container, as a Podman Quadlet unit, or from source behind a reverse proxy, plus every environment variable, sign-on options, backups, and upgrades.

## Requirements

- Container: nothing beyond Podman or Docker. The image is based on `node:22-bookworm-slim` and runs as the unprivileged `node` user.
- From source: Node.js 22 or newer (`engines.node >= 22` in `package.json`) and npm. `better-sqlite3` is a native module; `npm ci` builds or downloads it.
- Outbound HTTPS from the server to your model provider (Anthropic, OpenAI, or an OpenAI-compatible server) if you configure one, and to your OpenID Connect issuer if you use single sign-on. With no provider configured the helper runs in a limited rule-based mode.
- A reverse proxy for TLS. Piecewise serves plain HTTP only.
- One host. Storage is a SQLite file in WAL mode on local disk. Do not run more than one instance against the same file, and do not put the file on a network share.
- Piecewise must be served at the root of a hostname. Routes are fixed at `/` and `/api/`; there is no path-prefix setting.

## Running with Podman or Docker

Published image: `ghcr.io/christag/piecewise` (built by `.github/workflows/ci.yml` for `linux/amd64` and `linux/arm64`; `latest` tracks `main`, and `v*` tags produce version tags). To build locally:

```sh
podman build -t piecewise .
```

Run it:

```sh
podman run -d --name piecewise \
  -p 3000:3000 \
  -v piecewise-data:/data \
  -e APP_SECRET="$(openssl rand -base64 32)" \
  -e BASE_URL=https://piecewise.example.com \
  -e BOOTSTRAP_ADMIN_EMAIL=you@example.com \
  -e BOOTSTRAP_ADMIN_PASSWORD='at-least-ten-characters' \
  ghcr.io/christag/piecewise:latest
```

`docker run` takes the same arguments.

What the image sets for you (from the `Containerfile`): `NODE_ENV=production`, `PORT=3000`, `HOST=0.0.0.0`, `DATA_DIR=/data`, `PLUGINS_DIR=/plugins`. `/data` is declared as a volume. A `HEALTHCHECK` calls `/api/health` every 30 seconds.

What you provide:

- `APP_SECRET`: encrypts API keys at rest. If you omit it, the server generates one and writes it to `/data/.app-secret`. Set it explicitly so you can back it up and rotate it (see [Data and backups](#data-and-backups)).
- `BASE_URL`: the address people type into the browser. It decides whether cookies are marked `Secure` and is required for single sign-on.
- `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD`: create the first app administrator, once, when the database is empty. The password must be at least 10 characters or the bootstrap is skipped with a warning in the log. The account is flagged to change its password on first sign-in. If you skip these variables, the first visit to the site redirects to `/setup`, which creates the first administrator and works only while there are no users.
- Extra plugins: mount a directory at `/plugins`. Each plugin is a subdirectory holding a `plugin.json` whose `id` matches the directory name. Plugins load on start and on "Reload from disk" in Admin → Integrations (`POST /api/admin/plugins/reload`).

## Compose

`compose.yaml` at the repository root:

```yaml
services:
  piecewise:
    build: .
    image: ghcr.io/christag/piecewise:latest
    ports:
      - "3000:3000"
    environment:
      APP_SECRET: ${APP_SECRET:?set APP_SECRET in .env}
      BASE_URL: ${BASE_URL:-http://localhost:3000}
      BOOTSTRAP_ADMIN_EMAIL: ${BOOTSTRAP_ADMIN_EMAIL:-}
      BOOTSTRAP_ADMIN_PASSWORD: ${BOOTSTRAP_ADMIN_PASSWORD:-}
      OIDC_ISSUER: ${OIDC_ISSUER:-}
      OIDC_CLIENT_ID: ${OIDC_CLIENT_ID:-}
      OIDC_CLIENT_SECRET: ${OIDC_CLIENT_SECRET:-}
      TRUST_PROXY: ${TRUST_PROXY:-false}
    volumes:
      - piecewise-data:/data
      - ./plugins-extra:/plugins:ro
    restart: unless-stopped

volumes:
  piecewise-data:
```

Copy `.env.example` to `.env`, set at least `APP_SECRET`, then:

```sh
podman compose up -d      # or: docker compose up -d
```

The file names both `build: .` and the published image. `up` uses a local image if one exists and builds otherwise; `podman compose pull` fetches the published one. The `.env` file is read by compose only; variables not listed under `environment:` (for example `OIDC_ADMIN_EMAILS`) have to be added there before the container sees them.

## Podman Quadlet

`deploy/piecewise.container` is a Quadlet unit:

```ini
[Unit]
Description=Piecewise — turn a big thought into pieces an AI can build
After=network-online.target
Wants=network-online.target

[Container]
Image=ghcr.io/christag/piecewise:latest
ContainerName=piecewise
PublishPort=3000:3000
Volume=piecewise-data:/data
EnvironmentFile=%h/.config/piecewise/piecewise.env
AutoUpdate=registry

[Service]
Restart=always
TimeoutStartSec=120

[Install]
WantedBy=default.target
```

Install it as a user unit:

```sh
mkdir -p ~/.config/containers/systemd ~/.config/piecewise
cp deploy/piecewise.container ~/.config/containers/systemd/
cp deploy/piecewise.env.example ~/.config/piecewise/piecewise.env
chmod 600 ~/.config/piecewise/piecewise.env
# edit piecewise.env: APP_SECRET, BASE_URL, BOOTSTRAP_ADMIN_*
systemctl --user daemon-reload
systemctl --user start piecewise
loginctl enable-linger "$USER"   # keep user services running after logout
```

For a system-wide unit, put the file in `/etc/containers/systemd/` instead, drop `--user`, and change `EnvironmentFile` to an absolute path (`%h` expands to the unit's home directory).

`AutoUpdate=registry` lets `podman auto-update` pull a newer image and restart the unit. To add extra plugins, add a line such as `Volume=%h/piecewise-plugins:/plugins:ro` under `[Container]`; the image already sets `PLUGINS_DIR=/plugins`.

## Running from source behind a reverse proxy

Build and start:

```sh
npm ci
npm run build          # shared, then web (Vite), then server (esbuild bundle)
APP_SECRET="$(openssl rand -base64 32)" \
BASE_URL=https://piecewise.example.com \
TRUST_PROXY=true \
NODE_ENV=production \
npm start              # node server/dist/server.js
```

The server looks for the web build at `web/dist` (or `WEB_DIST_DIR`) and serves it as a single-page app. If it is missing you get a log line `web build not found; only the API is served`. For development, `npm run dev` runs the server with `tsx watch` on port 3000 and Vite on port 5173 with `/api` proxied to the server.

Proxy checklist:

- Terminate TLS at the proxy and forward to `HOST:PORT` (default `0.0.0.0:3000`; set `HOST=127.0.0.1` when the proxy is on the same machine).
- Pass the `Host` header through unchanged. State-changing requests that carry an `Origin` header are rejected with 403 unless the origin's host equals the request's `Host` or the host in `BASE_URL`; an `Origin` that cannot be parsed, or the literal `null`, is rejected too.
- Set `TRUST_PROXY=true` so Fastify reads `X-Forwarded-*`. Without it every request appears to come from the proxy's address, and the per-address rate limits (600 requests per minute overall, 10 per minute on `/api/auth/login`, 5 per minute on `/api/auth/setup`) apply to all users together.
- `SECURE_COOKIES` defaults to `true` when `BASE_URL` starts with `https://`. If you access the site over plain HTTP while it is `true`, browsers drop the session cookie and nobody can stay signed in. If you must serve HTTPS with an `http://` `BASE_URL`, set `SECURE_COOKIES=true` by hand.
- Request bodies are capped at 1,000,000 bytes by the server. A proxy limit at or above that is fine.
- The server already sends `X-Frame-Options: DENY`, a `Content-Security-Policy` with `frame-ancestors 'none'`, `X-Content-Type-Options`, `Referrer-Policy`, and `Permissions-Policy`. Do not add a second CSP at the proxy. The app cannot be embedded in an iframe.

## Environment variables

All values come from `server/src/config.ts`. Empty strings count as unset. Booleans accept `1`, `true`, `yes`, `on` (case-insensitive); anything else is false.

| Variable | Default | Meaning |
|---|---|---|
| `NODE_ENV` | `development` | `production`, `development`, or `test`. Development logs are pretty-printed; production logs are JSON lines. The image sets `production`. |
| `HOST` | `0.0.0.0` | Listen address. |
| `PORT` | `3000` | Listen port. |
| `BASE_URL` | unset | Public address, absolute `http://` or `https://` URL. Anything else is treated as unset. Required for OIDC. Sets the `SECURE_COOKIES` default and the OIDC redirect URI. |
| `DATA_DIR` | `./data` (relative to the working directory) | Created if missing. Holds the database and `.app-secret`. The image sets `/data`. |
| `DB_PATH` | `$DATA_DIR/piecewise.sqlite` | SQLite file. `-wal` and `-shm` files appear next to it. |
| `APP_SECRET` | generated, stored in `$DATA_DIR/.app-secret` | Key material for encrypting provider API keys (AES-256-GCM, key derived with scrypt). |
| `BUILTIN_PLUGINS_DIR` | auto-detected | The `plugins/` directory shipped with the app. Auto-detection tries `<server dist>/../../plugins`, `<server dist>/../plugins`, then `./plugins`. In the image this is `/app/plugins`. |
| `PLUGINS_DIR` | unset | Additional plugin directory, reported as source `installed`. The image sets `/plugins`. |
| `WEB_DIST_DIR` | auto-detected | The built web app. Auto-detection tries `<server dist>/../../web/dist`, `<server dist>/../web`, then `./web/dist`. |
| `TRUST_PROXY` | `false` | Trust `X-Forwarded-*` headers from the proxy. |
| `SECURE_COOKIES` | `true` if `BASE_URL` starts with `https://`, else `false` | Mark the session and OIDC flow cookies `Secure`. |
| `SESSION_DAYS` | `14` | Session lifetime. Expired sessions are purged on start and on use. |
| `LOG_LEVEL` | `info` (`silent` when `NODE_ENV=test`) | pino log level. |
| `AUTH_LOCAL` | `true` | Allow email and password sign-in. When `false`, `/api/auth/login` returns 403 and the password form is hidden. |
| `OIDC_ISSUER` | unset | Issuer URL. Setting it turns single sign-on on. |
| `OIDC_CLIENT_ID` | unset | Required when `OIDC_ISSUER` is set; the server refuses to start without it. |
| `OIDC_CLIENT_SECRET` | unset | Optional. When empty the client is registered as a public client and relies on PKCE. |
| `OIDC_SCOPES` | `openid email profile` | Scopes requested. |
| `OIDC_BUTTON_LABEL` | `Sign in with single sign-on` | Text on the sign-in button. |
| `OIDC_DEFAULT_ROLE` | `user` | Role for accounts created by SSO: `user`, `integration_admin`, or `app_admin`. Unknown values fall back to `user`. |
| `OIDC_ADMIN_EMAILS` | unset | Comma-separated, case-insensitive. These emails become `app_admin` when their account is first created by SSO. |
| `AUTH_TRUSTED_HEADER` | unset | Name of the request header carrying the signed-in user's email. Setting it turns trusted-header sign-in on. |
| `AUTH_TRUSTED_NAME_HEADER` | unset | Header carrying the display name. Without it the part of the email before `@` is used. |
| `AUTH_TRUSTED_PROXY_TOKEN` | unset | If set, headers are honored only when the request carries `X-Piecewise-Proxy-Token` with exactly this value. |
| `AUTH_TRUSTED_DEFAULT_ROLE` | `user` | Role for accounts created by trusted-header sign-in. |
| `BOOTSTRAP_ADMIN_EMAIL` | unset | First administrator, created only when there are no users. |
| `BOOTSTRAP_ADMIN_PASSWORD` | unset | At least 10 characters, or the bootstrap is skipped. |
| `BOOTSTRAP_ADMIN_NAME` | `Administrator` | Display name for the bootstrap account. |

Startup fails with an error in two cases: `OIDC_ISSUER` without `OIDC_CLIENT_ID`, and `OIDC_ISSUER` without a valid `BASE_URL`.

## Single sign-on (OpenID Connect)

Piecewise uses `openid-client` with the authorization code flow, PKCE (`S256`), `state`, and `nonce`. Provider settings are read from the issuer's discovery document (`<issuer>/.well-known/openid-configuration`).

1. Register a web application at your identity provider with this redirect URI:

   ```
   <BASE_URL>/api/auth/oidc/callback
   ```

   The path is resolved against the origin of `BASE_URL`, so use a `BASE_URL` with no path.

2. Set the variables:

   ```sh
   BASE_URL=https://piecewise.example.com
   OIDC_ISSUER=https://your-issuer.example.com
   OIDC_CLIENT_ID=...
   OIDC_CLIENT_SECRET=...        # omit for a public client
   OIDC_ADMIN_EMAILS=you@example.com
   ```

3. Restart. The sign-in page shows a button labeled by `OIDC_BUTTON_LABEL`; it links to `/api/auth/oidc/start`. Once SSO works, set `AUTH_LOCAL=false` to remove password sign-in.

How identities map to accounts:

- The server reads `email` and `name` from the ID token, falling back to the userinfo endpoint. Sign-in fails with "The identity provider did not share an email address" if no email is available, so keep the `email` scope.
- Identity is the provider's `sub` claim, stored on the account (`users.oidc_sub`). On the first sign-in of a subject, an existing account with the same email (case-insensitive) is linked to it, unless the provider reports `email_verified: false`, in which case sign-in is refused. An account already linked to a different subject refuses the new one. Otherwise a new account is created: `app_admin` if the email is in `OIDC_ADMIN_EMAILS`, else `OIDC_DEFAULT_ROLE`. Roles are set only at creation; later sign-ins do not change them, and there is no group-to-role mapping from claims. Change roles in Admin → Users.
- A disabled account is refused at the callback.
- Flow state is kept in the `oidc_flows` table, tied to a `piecewise_oidc` cookie that lives 10 minutes.
- Signing out deletes the Piecewise session only. There is no provider-side logout and no refresh-token handling; sessions last `SESSION_DAYS`.

First run with SSO: `/setup` creates a local administrator and does not offer the SSO button. Either complete `/setup` (or use `BOOTSTRAP_ADMIN_*`) and connect SSO afterwards, or, with your email in `OIDC_ADMIN_EMAILS`, open `/api/auth/oidc/start` directly; the endpoint does not require setup to be finished.

Provider notes, in generic terms. Take the exact issuer from the provider's own discovery document.

- Microsoft Entra ID: the issuer is typically `https://login.microsoftonline.com/<tenant-id>/v2.0`. Register a "Web" platform redirect URI and create a client secret.
- Okta: the issuer is your Okta domain, or a custom authorization server such as `https://<org>.okta.com/oauth2/default`. Create an OIDC web application with the redirect URI above.
- Google: the issuer is `https://accounts.google.com`. Create an OAuth client of type "Web application". Google puts `email` and `name` in the ID token when the `email` and `profile` scopes are granted.
- Keycloak and Authentik work the same way through discovery.

An `http://` issuer is accepted (insecure requests are enabled for it) so you can test against a local mock. The OIDC flow is covered by automated tests against `oauth2-mock-server` (`server/test/oidc.test.ts`); it has not been verified against any specific vendor.

## Trusted-header sign-in

Use this when an authenticating proxy (oauth2-proxy, Cloudflare Access, Pomerium, or similar) already identifies the user and forwards their email in a request header.

```sh
AUTH_TRUSTED_HEADER=x-forwarded-email
AUTH_TRUSTED_NAME_HEADER=x-forwarded-user          # optional
AUTH_TRUSTED_PROXY_TOKEN="$(openssl rand -base64 32)"
AUTH_TRUSTED_DEFAULT_ROLE=user
```

Header names are compared case-insensitively. Check your proxy's documentation for what it sends; oauth2-proxy uses `X-Forwarded-Email` and `X-Forwarded-User` when configured to pass user headers, and Cloudflare Access uses `Cf-Access-Authenticated-User-Email`.

Behavior, from `server/src/auth/plugin.ts`:

- On every request without a valid session cookie, the server reads the email header. The value must contain `@`. An unknown email creates an account with `AUTH_TRUSTED_DEFAULT_ROLE` and `auth_source` `trusted-header`; a disabled account is ignored.
- No session cookie is issued. The user is identified per request, so signing out is the proxy's job; the app's sign-out only clears a cookie that was never set.
- If `AUTH_TRUSTED_PROXY_TOKEN` is set, headers are honored only when the request also carries `X-Piecewise-Proxy-Token` with exactly that value. Set the token, and add the header at the component that talks directly to Piecewise (for example a `proxy_set_header` in nginx or `header_up` in Caddy). Without the token, anyone who can reach port 3000 directly can claim any email. Regardless of the token, keep the port reachable only from the proxy.
- Trusted-header accounts have no password; "reset password" in Admin → Users refuses them.

Getting the first administrator: start with `AUTH_TRUSTED_DEFAULT_ROLE=app_admin`, sign in once, then change it back to `user` and restart. Or create a local administrator with `BOOTSTRAP_ADMIN_*` and promote users in Admin → Users.

## Data and backups

Everything lives in `DATA_DIR`:

| File | Contents |
|---|---|
| `piecewise.sqlite` (plus `-wal`, `-shm`) | Users (scrypt password hashes), sessions, plans, pieces, helper messages, provider settings with encrypted API keys, plugin settings, organization settings, audit log, in-flight OIDC flows. |
| `.app-secret` | Generated `APP_SECRET`, mode `0600`. Present only if `APP_SECRET` was not set on first start. |

Backup: stop the service, copy the whole directory, start it again. If you copy while running, copy the `.sqlite`, `-wal`, and `-shm` files together, or take a consistent snapshot with the SQLite CLI from the host (`sqlite3 piecewise.sqlite ".backup 'piecewise-backup.sqlite'"`; the CLI is not in the image). For a named Podman volume, `podman volume inspect piecewise-data` prints the mount point.

Restore: stop the service, put the files back in `DATA_DIR`, and start. If you rely on the generated `.app-secret`, restore it with the database or stored API keys become unreadable.

### Rotating `APP_SECRET`

Provider API keys are the only data encrypted with `APP_SECRET`. Passwords are salted hashes and session ids are random tokens, so both survive a rotation.

After a change, the stored keys cannot be decrypted:

- Admin → AI shows the key hint `•••• (unreadable: APP_SECRET changed)`.
- Helper calls fall back to rule-based guidance with the notice "The stored API key can't be decrypted. APP_SECRET probably changed; re-enter the key in Admin → AI."

The app never returns a stored key (only its last four characters), so have the keys at hand before rotating. Procedure:

1. Set the new `APP_SECRET` and restart.
2. In Admin → AI, edit each provider and enter its API key again. Use "Test" to confirm.

The same breakage happens when you start setting `APP_SECRET` after running without it (the generated `.app-secret` is then ignored), or when you move to a new host without the `.app-secret` file.

## Health endpoint

`GET /api/health` needs no authentication:

```json
{
  "ok": true,
  "version": "0.1.0",
  "plugins": 23,
  "pluginProblems": 0,
  "helper": { "configured": true, "provider": { "label": "Claude", "kind": "anthropic", "model": "claude-opus-5" } }
}
```

`helper.configured` is `true` when an active AI provider exists; it does not test the key. The image's `HEALTHCHECK` and the CI workflow both poll this endpoint. It counts toward the 600-requests-per-minute limit like every other route.

## Upgrading

Schema migrations run at start (`server/src/db/migrations.ts`, tracked in the `schema_migrations` table). They are forward-only; there is no downgrade. Back up `DATA_DIR` first.

- Container: pull the new image and recreate the container (`podman pull ghcr.io/christag/piecewise:latest` then re-run, or `podman compose pull && podman compose up -d`).
- Quadlet: `podman auto-update`, or pull and `systemctl --user restart piecewise`.
- Source: `git pull && npm ci && npm run build`, then restart the process.

Built-in plugins ship inside the image and update with it. Plugins in `PLUGINS_DIR` are yours to update; reload them from Admin → Integrations without a restart. Plugin settings (enabled, owner, guidance, hidden objects and actions) are stored in the database and survive both.

## Logs

The server logs to stdout through pino. With `NODE_ENV=production` each line is JSON; in development it is pretty-printed. `LOG_LEVEL` controls verbosity.

```sh
podman logs -f piecewise
journalctl --user -u piecewise -f     # Quadlet
```

Lines worth knowing:

- `loaded N plugins` and `plugin skipped` (with `dir` and `errors`) at start.
- `created bootstrap administrator` when `BOOTSTRAP_ADMIN_*` takes effect; a warning if the password is too short.
- `web build not found; only the API is served`.
- `Piecewise is listening on http://0.0.0.0:3000`.
- `helper model call failed; using rules` and `brief generation failed; using template` when the model provider errors.
- `oidc callback failed` with the error.
- `request failed` at error level for any 5xx response.

Who did what is recorded separately in the audit log inside the database: sign-ins and failures, user and provider changes, plugin and settings changes. Read it in Admin → Audit log or `GET /api/admin/audit?limit=100` (maximum 500), as an app administrator.
