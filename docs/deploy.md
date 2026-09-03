# Deploying Planifold

Planifold is one Node.js process with one SQLite file. There is no database server, no queue, and no cache to run. This document covers running it in a container, as a Podman Quadlet unit, or from source behind a reverse proxy, plus every environment variable, sign-on options, backups, and upgrades.

## Requirements

- Container: nothing beyond Podman or Docker. The image is based on `node:22-bookworm-slim` and runs as the unprivileged `node` user.
- From source: Node.js 22 or newer (`engines.node >= 22` in `package.json`) and npm. `better-sqlite3` is a native module; `npm ci` builds or downloads it.
- Outbound HTTPS from the server to your model provider (Anthropic, OpenAI, or an OpenAI-compatible server) if you configure one, and to your OpenID Connect issuer if you use OIDC single sign-on. SAML single sign-on needs no outbound connection (the browser carries the messages). SCIM provisioning is inbound: the identity provider must be able to reach `BASE_URL`. With no provider configured Plani runs in a limited rule-based mode.
- A reverse proxy for TLS. Planifold serves plain HTTP only.
- One host. Storage is a SQLite file in WAL mode on local disk. Do not run more than one instance against the same file, and do not put the file on a network share.
- Planifold must be served at the root of a hostname. Routes are fixed at `/` and `/api/`; there is no path-prefix setting.

## Running with Podman or Docker

Published image: `ghcr.io/christag/planifold` (built by `.github/workflows/ci.yml` for `linux/amd64` and `linux/arm64`; `latest` tracks `main`, and `v*` tags produce version tags). To build locally:

```sh
podman build -t planifold .
```

Run it:

```sh
podman run -d --name planifold \
  -p 3000:3000 \
  -v planifold-data:/data \
  -e APP_SECRET="$(openssl rand -base64 32)" \
  -e BASE_URL=https://planifold.example.com \
  -e BOOTSTRAP_ADMIN_EMAIL=you@example.com \
  -e BOOTSTRAP_ADMIN_PASSWORD='at-least-ten-characters' \
  ghcr.io/christag/planifold:latest
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
  planifold:
    build: .
    image: ghcr.io/christag/planifold:latest
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
      SAML_IDP_SSO_URL: ${SAML_IDP_SSO_URL:-}
      SAML_IDP_ISSUER: ${SAML_IDP_ISSUER:-}
      SAML_IDP_CERT: ${SAML_IDP_CERT:-}
      SAML_ADMIN_EMAILS: ${SAML_ADMIN_EMAILS:-}
      SAML_ENFORCE: ${SAML_ENFORCE:-false}
      TRUST_PROXY: ${TRUST_PROXY:-false}
    volumes:
      - planifold-data:/data
      - ./plugins-extra:/plugins:ro
    restart: unless-stopped

volumes:
  planifold-data:
```

Copy `.env.example` to `.env`, set at least `APP_SECRET`, then:

```sh
podman compose up -d      # or: docker compose up -d
```

The file names both `build: .` and the published image. `up` uses a local image if one exists and builds otherwise; `podman compose pull` fetches the published one. The `.env` file is read by compose only; variables not listed under `environment:` (for example `OIDC_ADMIN_EMAILS` or `SAML_ADMIN_GROUPS`) have to be added there before the container sees them. A multi-line certificate in `.env` is easiest written on one line with `\n` between the lines; the server unescapes it.

## Podman Quadlet

`deploy/planifold.container` is a Quadlet unit:

```ini
[Unit]
Description=Planifold — turn a big thought into pieces an AI can build
After=network-online.target
Wants=network-online.target

[Container]
Image=ghcr.io/christag/planifold:latest
ContainerName=planifold
PublishPort=3000:3000
Volume=planifold-data:/data
EnvironmentFile=%h/.config/planifold/planifold.env
AutoUpdate=registry

[Service]
Restart=always
TimeoutStartSec=120

[Install]
WantedBy=default.target
```

Install it as a user unit:

```sh
mkdir -p ~/.config/containers/systemd ~/.config/planifold
cp deploy/planifold.container ~/.config/containers/systemd/
cp deploy/planifold.env.example ~/.config/planifold/planifold.env
chmod 600 ~/.config/planifold/planifold.env
# edit planifold.env: APP_SECRET, BASE_URL, BOOTSTRAP_ADMIN_*
systemctl --user daemon-reload
systemctl --user start planifold
loginctl enable-linger "$USER"   # keep user services running after logout
```

For a system-wide unit, put the file in `/etc/containers/systemd/` instead, drop `--user`, and change `EnvironmentFile` to an absolute path (`%h` expands to the unit's home directory).

`AutoUpdate=registry` lets `podman auto-update` pull a newer image and restart the unit. To add extra plugins, add a line such as `Volume=%h/planifold-plugins:/plugins:ro` under `[Container]`; the image already sets `PLUGINS_DIR=/plugins`.

## Running from source behind a reverse proxy

Build and start:

```sh
npm ci
npm run build          # shared, then web (Vite), then server (esbuild bundle)
APP_SECRET="$(openssl rand -base64 32)" \
BASE_URL=https://planifold.example.com \
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
| `DB_PATH` | `$DATA_DIR/planifold.sqlite` | SQLite file. `-wal` and `-shm` files appear next to it. |
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
| `AUTH_TRUSTED_PROXY_TOKEN` | unset | If set, headers are honored only when the request carries `X-Planifold-Proxy-Token` with exactly this value. |
| `AUTH_TRUSTED_DEFAULT_ROLE` | `user` | Role for accounts created by trusted-header sign-in. |
| `SAML_IDP_SSO_URL` | unset | The identity provider's single sign-on URL. Setting any of the three `SAML_IDP_*` values turns SAML on; all three are then required. |
| `SAML_IDP_ISSUER` | unset | The identity provider's entity id (Okta calls it "Identity Provider Issuer"). Responses from any other issuer are refused. |
| `SAML_IDP_CERT` | unset | The identity provider's X.509 signing certificate, PEM or bare base64. Several PEM blocks may be concatenated during a key rotation. `SAML_IDP_CERT_FILE` reads it from a file instead. |
| `SAML_SP_ENTITY_ID` | `<BASE_URL>/api/auth/saml/metadata` | This service provider's entity id, also used as the expected audience. |
| `SAML_SP_PRIVATE_KEY`, `SAML_SP_CERT` | unset | Optional key pair (PEM; `_FILE` variants exist) for signing authentication requests and decrypting encrypted assertions. Both or neither. |
| `SAML_NAMEID_FORMAT` | unset | NameID format to ask for. Unset lets the identity provider choose. |
| `SAML_WANT_RESPONSE_SIGNED` | `true` | Require a signature on the whole response as well as on the assertion (Okta signs both by default). |
| `SAML_ALLOW_IDP_INITIATED` | `false` | Accept responses that did not answer a request from Planifold, so people can start from the identity provider's dashboard. |
| `SAML_CLOCK_SKEW_SECONDS` | `120` | Tolerance when checking assertion validity times. |
| `SAML_BUTTON_LABEL` | `Sign in with SAML single sign-on` | Text on the sign-in button. |
| `SAML_DEFAULT_ROLE` | `user` | Role for accounts created by SAML sign-in or SCIM. |
| `SAML_ADMIN_EMAILS` | unset | Comma-separated, case-insensitive. These emails become `app_admin` when their account is created by SAML or SCIM, or on the first SAML sign-in of a SCIM-provisioned account. |
| `SAML_ADMIN_GROUPS` | unset | Comma-separated group names. A person whose `groups` attribute names one of them becomes `app_admin` at the same moments. |
| `SAML_ATTR_EMAIL`, `SAML_ATTR_NAME`, `SAML_ATTR_FIRST_NAME`, `SAML_ATTR_LAST_NAME`, `SAML_ATTR_GROUPS` | `email`, `name`, `firstName`, `lastName`, `groups` | Names of the assertion attributes to read. |
| `SAML_ENFORCE` | `false` | Make SAML the only way in: password, OIDC, and trusted-header sign-in are turned off, `/setup` is closed, and sessions that did not come through SAML are ended. |
| `BOOTSTRAP_ADMIN_EMAIL` | unset | First administrator, created only when there are no users. |
| `BOOTSTRAP_ADMIN_PASSWORD` | unset | At least 10 characters, or the bootstrap is skipped. |
| `BOOTSTRAP_ADMIN_NAME` | `Administrator` | Display name for the bootstrap account. |

Startup fails with an error when: `OIDC_ISSUER` is set without `OIDC_CLIENT_ID`; OIDC or SAML is configured without a valid `BASE_URL`; only some of `SAML_IDP_SSO_URL`, `SAML_IDP_ISSUER`, `SAML_IDP_CERT` are set; `SAML_SP_PRIVATE_KEY` and `SAML_SP_CERT` are not set together; a `_FILE` variable points at a missing file; or `SAML_ENFORCE` is set without SAML configured.

## Single sign-on (OpenID Connect)

Planifold uses `openid-client` with the authorization code flow, PKCE (`S256`), `state`, and `nonce`. Provider settings are read from the issuer's discovery document (`<issuer>/.well-known/openid-configuration`).

1. Register a web application at your identity provider with this redirect URI:

   ```
   <BASE_URL>/api/auth/oidc/callback
   ```

   The path is resolved against the origin of `BASE_URL`, so use a `BASE_URL` with no path.

2. Set the variables:

   ```sh
   BASE_URL=https://planifold.example.com
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
- Flow state is kept in the `oidc_flows` table, tied to a `planifold_oidc` cookie that lives 10 minutes.
- Signing out deletes the Planifold session only. There is no provider-side logout and no refresh-token handling; sessions last `SESSION_DAYS`.

First run with SSO: `/setup` creates a local administrator and does not offer the SSO button. Either complete `/setup` (or use `BOOTSTRAP_ADMIN_*`) and connect SSO afterwards, or, with your email in `OIDC_ADMIN_EMAILS`, open `/api/auth/oidc/start` directly; the endpoint does not require setup to be finished.

Provider notes, in generic terms. Take the exact issuer from the provider's own discovery document.

- Microsoft Entra ID: the issuer is typically `https://login.microsoftonline.com/<tenant-id>/v2.0`. Register a "Web" platform redirect URI and create a client secret.
- Okta: the issuer is your Okta domain, or a custom authorization server such as `https://<org>.okta.com/oauth2/default`. Create an OIDC web application with the redirect URI above.
- Google: the issuer is `https://accounts.google.com`. Create an OAuth client of type "Web application". Google puts `email` and `name` in the ID token when the `email` and `profile` scopes are granted.
- Keycloak and Authentik work the same way through discovery.

An `http://` issuer is accepted (insecure requests are enabled for it) so you can test against a local mock. The OIDC flow is covered by automated tests against `oauth2-mock-server` (`server/test/oidc.test.ts`); it has not been verified against any specific vendor.

## Single sign-on (SAML 2.0)

Planifold is a SAML 2.0 service provider through `@node-saml/node-saml`: HTTP-Redirect binding for the authentication request, HTTP-POST binding for the response, signed assertions required, response signature required by default, audience and issuer checked, and every response must answer a request Planifold issued unless `SAML_ALLOW_IDP_INITIATED` is on. The configuration below is written for Okta; any SAML 2.0 identity provider that can send an email attribute works the same way.

### Okta setup

1. In Okta Admin, go to Applications → Create App Integration → SAML 2.0.
2. General settings: any name, for example "Planifold".
3. SAML settings:

   | Okta field | Value |
   |---|---|
   | Single sign-on URL | `<BASE_URL>/api/auth/saml/callback` (leave "Use this for Recipient URL and Destination URL" checked) |
   | Audience URI (SP Entity ID) | `<BASE_URL>/api/auth/saml/metadata` (or whatever you put in `SAML_SP_ENTITY_ID`) |
   | Default RelayState | empty, or a path such as `/` (only used with `SAML_ALLOW_IDP_INITIATED`) |
   | Name ID format | Unspecified or EmailAddress; Persistent also works |
   | Application username | Okta username (or Email) |

   Attribute statements (name → value): `email` → `user.email`, `firstName` → `user.firstName`, `lastName` → `user.lastName`. Optionally a group attribute statement named `groups` with a filter that matches the groups you want Planifold to see (for `SAML_ADMIN_GROUPS`). The names are configurable with `SAML_ATTR_*` if your organization already uses others.

4. Finish, then open the app's Sign On tab and click "View SAML setup instructions" (or "More details"). Copy the three values into the environment:

   ```sh
   BASE_URL=https://planifold.example.com
   SAML_IDP_SSO_URL=https://your-org.okta.com/app/…/sso/saml     # "Identity Provider Single Sign-On URL"
   SAML_IDP_ISSUER=http://www.okta.com/exk…                        # "Identity Provider Issuer"
   SAML_IDP_CERT_FILE=/etc/planifold/okta.pem                     # "X.509 Certificate", or inline as SAML_IDP_CERT
   SAML_ADMIN_EMAILS=you@example.com
   ```

5. Assign people or groups to the app in Okta, restart Planifold, and check Admin → Sign-in: it shows the ACS URL, entity id, and metadata URL to compare against Okta. The sign-in page now has a button labeled by `SAML_BUTTON_LABEL`; it links to `/api/auth/saml/start`. Service-provider metadata is served at `/api/auth/saml/metadata` for identity providers that can import it.

Okta signs both the response and the assertion by default; keep it that way. If you enable assertion encryption in Okta, give Planifold a key pair with `SAML_SP_PRIVATE_KEY_FILE` and `SAML_SP_CERT_FILE`, upload the certificate to Okta as the encryption certificate; the same pair also signs Planifold's requests, which Okta accepts but does not require.

### How identities map to accounts

- The email comes from the attribute named by `SAML_ATTR_EMAIL` (`email`), falling back to the NameID when it looks like an email address. Without one, sign-in fails with a message naming the attribute to add. The display name is `SAML_ATTR_NAME`, else first and last name joined, else the part of the email before `@`.
- Identity is the NameID, stored on the account (`users.saml_name_id`). On the first sign-in of a NameID, the server looks for an account provisioned by SCIM whose external id equals the NameID (Okta can send `user.id` as both), then for an account with the same email (case-insensitive), and links it. An account already linked to a different NameID refuses the new one. Otherwise a new account is created: `app_admin` if the email is in `SAML_ADMIN_EMAILS` or a `groups` value is in `SAML_ADMIN_GROUPS`, else `SAML_DEFAULT_ROLE`.
- Roles are decided when an account is created, and once more on the first SAML sign-in of an account that SCIM provisioned (upwards only, so that an administrator listed in `SAML_ADMIN_EMAILS` still becomes one when Okta created the account first). Later sign-ins never change roles; change them in Admin → Users. Group membership sent in assertions is not stored.
- Linking clears any pending "must change password" flag. An account an administrator created with a temporary password would otherwise be stuck: the app would ask for a new password and `POST /api/auth/password` would refuse it, because the identity provider now owns the account.
- A disabled account is refused at the callback.
- Flow state is kept in two tables: `saml_requests` holds the ids of requests Planifold issued (10 minutes), and `saml_flows` remembers where to send the person afterwards, keyed by the RelayState. No cookie is involved, because the identity provider posts the response from its own origin and a `SameSite=Lax` cookie would not travel with it.
- Signing out deletes the Planifold session only. There is no single logout.

### Getting the first administrator with SAML

`/setup` creates a password administrator and is available while password sign-in is on. With SAML, the simpler path is to put your email in `SAML_ADMIN_EMAILS` and sign in; `/api/auth/saml/start` does not require setup to have happened. With `SAML_ENFORCE` (below) `/setup` is closed, so `SAML_ADMIN_EMAILS` or `SAML_ADMIN_GROUPS` is the only way to get the first administrator.

### IdP-initiated sign-in

By default a response must answer a request Planifold issued (`InResponseTo` is checked against `saml_requests`), so a sign-in has to start from the Planifold sign-in page. Clicking the app in the Okta dashboard sends an unsolicited response, which is refused with "Sign-in must start from Planifold". Set `SAML_ALLOW_IDP_INITIATED=true` to accept those; Okta's "Default RelayState" is then used as the landing path when it is a same-site path. Unsolicited responses are still checked for signature, issuer, audience, and validity window, but they can be replayed within that window by anyone who obtains one, which is why this is off by default.

### Enforcing SAML

```sh
SAML_ENFORCE=true
```

With this set, SAML is the only way in:

- `AUTH_LOCAL` is treated as `false`, and `OIDC_*` and `AUTH_TRUSTED_*` are ignored. `/api/auth/login` and `/api/auth/setup` return 403; the sign-in page sends people straight to the identity provider, showing an error first if the previous attempt failed.
- On start, every session that did not come through SAML is ended (sessions record how they were created in `sessions.via`), and such sessions are refused if they turn up later. People signed in with a password before the change have to sign in again through SAML.
- Accounts keep their roles and plans; a password account is linked to its SAML identity by email on first sign-in.
- Signing out returns to the sign-in page and stays there, rather than bouncing straight back to the identity provider. The provider usually still holds its own session, so the next sign-in can be a single click; ending that session is the provider's job, since there is no single logout.
- The server refuses to start if SAML is not fully configured.

Turn it on only after a SAML sign-in has worked with `SAML_ENFORCE` unset. To get back in if the identity provider breaks, unset `SAML_ENFORCE` and restart; password accounts (including `BOOTSTRAP_ADMIN_*`) work again immediately.

The SAML flow is covered by automated tests against a mock identity provider that signs responses the way Okta does (`server/test/saml.test.ts`); it has not been run against a live Okta org.

## Provisioning (SCIM 2.0)

Planifold is a SCIM 2.0 service provider at `<BASE_URL>/api/scim/v2` (`server/src/scim/`). An identity provider can create people before they ever sign in, keep names and emails current, deactivate and reactivate them, delete them, and push groups. It is written against Okta's SCIM client and follows RFC 7643/7644 closely enough for other clients.

### Okta setup

1. In Admin → Sign-in, create a SCIM token (give it a label such as "Okta"). It is shown once; copy it.
2. In Okta, the SAML app from above needs provisioning enabled. Either edit the app's General settings and check "Enable SCIM provisioning" (available for SAML apps created with the app integration wizard), or create a separate "SCIM 2.0 Test App (Header Auth)" integration.
3. On the Provisioning tab → Integration:

   | Okta field | Value |
   |---|---|
   | SCIM connector base URL | `<BASE_URL>/api/scim/v2` |
   | Unique identifier field for users | `userName` |
   | Supported provisioning actions | Push New Users, Push Profile Updates, Push Groups; Import New Users and Profile Updates if you want Okta to read existing accounts |
   | Authentication Mode | HTTP Header |
   | Authorization | the token from step 1 |

   "Test Connector Configuration" calls `/Users?filter=…`, `/Users`, and, if group push is selected, `/Groups`.

4. On Provisioning → To App, enable Create Users, Update User Attributes, and Deactivate Users. In the attribute mappings, keep `userName` mapped to the person's email (Okta's username is usually the email; if yours is not, map `userName` to `user.email`). `givenName`, `familyName`, `displayName`, and `email` are used; other attributes are accepted and ignored.
5. Assign people to the app; Okta creates them in Planifold at once. Push Groups sends group membership.

Okta reaches the SCIM endpoint from its own network, so `BASE_URL` must be reachable from the internet (or Okta's published IP ranges must be allowed through your firewall), over HTTPS.

### What SCIM does to accounts

| SCIM request | Effect |
|---|---|
| `POST /Users` | Creates an account with no password, `auth_source` `scim`, and `SAML_DEFAULT_ROLE` (or `app_admin` if the email is in `SAML_ADMIN_EMAILS`). `userName` must be an email address, or `emails` must carry one. Refused with 409 if the email or `externalId` already belongs to someone. |
| `GET /Users?filter=userName eq "…"` | Looks an account up by email (also `emails.value`, `externalId`, `id`). Okta calls this before every create, so an existing password or SSO account with that email is adopted rather than duplicated; from then on Okta updates it. |
| `PUT /Users/:id` | Replaces name, email, `externalId`, and `active`. |
| `PATCH /Users/:id` | Applies `add`, `replace`, and `remove` operations, with or without a `path` (Okta's deactivation is `replace` with `{ "active": false }`; `active` as `"True"`/`"False"` strings is accepted too). `active: false` disables the account and ends its sessions; `active: true` re-enables it. |
| `DELETE /Users/:id` | Deletes the account and its plans, like Admin → Users → Delete. Okta deactivates rather than deletes, so this is only reached by an explicit client action. |
| `POST`/`PUT`/`PATCH`/`DELETE /Groups` | Stores groups and membership (`scim_groups`, `scim_group_members`), visible in Admin → Sign-in. Members must be ids of existing users. Group names are unique, case-insensitively. Membership is informational: it does not change roles. |
| `GET /ServiceProviderConfig`, `/ResourceTypes`, `/Schemas` | Discovery. Filtering by one `eq` clause and pagination (`startIndex`, `count`, up to 500) are supported; sorting, bulk, and ETags are not. |

Accounts created by SCIM sign in through SAML (or OIDC): on their first sign-in the account is matched by external id or email and linked. In Admin → Users they show as "SSO" with a "provisioned" tag. Administrators can still edit, disable, or delete them, but Okta will push its own values again on the next update.

Tokens: any number can exist, each with a label; revoking one in Admin → Sign-in stops that client at once. Requests without a valid token get 401 with a SCIM error body; the session cookie is never accepted on `/api/scim/`. Every change made through SCIM is written to the audit log with the actor `scim:<token label>`.

The SCIM endpoints are covered by `server/test/scim.test.ts`, which sends the request shapes Okta sends; they have not been run against a live Okta org.

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
- If `AUTH_TRUSTED_PROXY_TOKEN` is set, headers are honored only when the request also carries `X-Planifold-Proxy-Token` with exactly that value. Set the token, and add the header at the component that talks directly to Planifold (for example a `proxy_set_header` in nginx or `header_up` in Caddy). Without the token, anyone who can reach port 3000 directly can claim any email. Regardless of the token, keep the port reachable only from the proxy.
- Trusted-header accounts have no password; "reset password" in Admin → Users refuses them.

Getting the first administrator: start with `AUTH_TRUSTED_DEFAULT_ROLE=app_admin`, sign in once, then change it back to `user` and restart. Or create a local administrator with `BOOTSTRAP_ADMIN_*` and promote users in Admin → Users.

## Data and backups

Everything lives in `DATA_DIR`:

| File | Contents |
|---|---|
| `planifold.sqlite` (plus `-wal`, `-shm`) | Users (scrypt password hashes), sessions, plans, pieces, helper messages, provider settings with encrypted API keys, plugin settings, organization settings, audit log, in-flight OIDC and SAML flows, SCIM tokens (hashed) and groups. |
| `.app-secret` | Generated `APP_SECRET`, mode `0600`. Present only if `APP_SECRET` was not set on first start. |

Backup: stop the service, copy the whole directory, start it again. If you copy while running, copy the `.sqlite`, `-wal`, and `-shm` files together, or take a consistent snapshot with the SQLite CLI from the host (`sqlite3 planifold.sqlite ".backup 'planifold-backup.sqlite'"`; the CLI is not in the image). For a named Podman volume, `podman volume inspect planifold-data` prints the mount point.

Restore: stop the service, put the files back in `DATA_DIR`, and start. If you rely on the generated `.app-secret`, restore it with the database or stored API keys become unreadable.

### Rotating `APP_SECRET`

Provider API keys are the only data encrypted with `APP_SECRET`. Passwords are salted hashes and session ids are random tokens, so both survive a rotation.

After a change, the stored keys cannot be decrypted:

- Admin → AI shows the key hint `•••• (unreadable: APP_SECRET changed)`.
- Plani falls back to rule-based guidance with the notice "The stored API key can't be decrypted. APP_SECRET probably changed; re-enter the key in Admin → AI."

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

- Container: pull the new image and recreate the container (`podman pull ghcr.io/christag/planifold:latest` then re-run, or `podman compose pull && podman compose up -d`).
- Quadlet: `podman auto-update`, or pull and `systemctl --user restart planifold`.
- Source: `git pull && npm ci && npm run build`, then restart the process.

Built-in plugins ship inside the image and update with it. Plugins in `PLUGINS_DIR` are yours to update; reload them from Admin → Integrations without a restart. Plugin settings (enabled, owner, guidance, hidden objects and actions) are stored in the database and survive both.

### Upgrading from Piecewise

The project was renamed to Planifold, and the assistant is now called Plani. Your data comes across untouched: plans, accounts, roles, provider keys, and the audit log all live in the same database, and no migration rewrites them. What changes on the first start of a renamed build:

| Was | Is now | What to do |
|---|---|---|
| `piecewise.sqlite` | `planifold.sqlite` | Nothing. An existing `piecewise.sqlite` keeps being used; only a fresh install creates the new name. Set `DB_PATH` to pin either. |
| `piecewise_session`, `piecewise_oidc` cookies | `planifold_session`, `planifold_oidc` | Nothing. Everyone signs in once more. |
| `X-Piecewise-Proxy-Token` | `X-Planifold-Proxy-Token` | Rename the header your proxy sends, if you use trusted-header sign-in. Until you do, the header is ignored and those people cannot sign in. |
| `ghcr.io/christag/piecewise` | `ghcr.io/christag/planifold` | Point your pull, compose file, or Quadlet unit at the new image. The old package stops receiving builds. |
| `piecewise-data` volume, `deploy/piecewise.container`, `~/.config/piecewise/` | the same names with `planifold` | Rename them, or keep yours and adjust the unit; nothing reads the directory name. |
| SCIM tokens beginning `pcw_scim_` | new ones begin `pfd_scim_` | Nothing. Existing tokens keep working; only their displayed prefix looks older. |

`APP_SECRET` is unaffected: the key that encrypts provider API keys is derived from a constant that deliberately did not change, so stored keys stay readable.

## Logs

The server logs to stdout through pino. With `NODE_ENV=production` each line is JSON; in development it is pretty-printed. `LOG_LEVEL` controls verbosity.

```sh
podman logs -f planifold
journalctl --user -u planifold -f     # Quadlet
```

Lines worth knowing:

- `loaded N plugins` and `plugin skipped` (with `dir` and `errors`) at start.
- `created bootstrap administrator` when `BOOTSTRAP_ADMIN_*` takes effect; a warning if the password is too short.
- `web build not found; only the API is served`.
- `Planifold is listening on http://0.0.0.0:3000`.
- `helper model call failed; using rules` and `brief generation failed; using template` when the model provider errors.
- `oidc callback failed` and `saml callback failed` with the error.
- `SAML is enforced; ended sessions that did not come through SAML` at start when `SAML_ENFORCE` is on and there were such sessions.
- `scim request failed` at error level for a 5xx on a SCIM endpoint.
- `request failed` at error level for any other 5xx response.

Who did what is recorded separately in the audit log inside the database: sign-ins and failures, user and provider changes, plugin and settings changes, SCIM changes (actor `scim:<token label>`), and SCIM token creation and revocation. Read it in Admin → Audit log or `GET /api/admin/audit?limit=100` (maximum 500), as an app administrator.
