# Contributing to Piecewise

## Setup

You need Node 22 or newer (`engines` in `package.json`) and npm.

```sh
npm ci
npm run dev
```

`npm run dev` starts two processes: the API server through `tsx watch server/src/index.ts` on port 3000, and the web app through Vite on port 5173. Vite proxies `/api` to the server (`web/vite.config.ts`), so open http://localhost:5173. The first visit goes to `/setup`, where you create the administrator account.

The server reads configuration from environment variables only; it does not load `.env` (that file is read by `compose.yaml`). Every value has a default in development. It writes its SQLite database and a generated `.app-secret` to `./data/`, which is gitignored. `server/src/config.ts` is the full list of variables.

Other scripts:

| Command | What it does |
|---|---|
| `npm run typecheck` | `tsc --noEmit` in every workspace |
| `npm run build` | Typechecks `shared`, builds `web/dist` with Vite, bundles `server/dist/server.js` with esbuild |
| `npm start` | Runs the built server, which also serves `web/dist` |
| `npm run validate-plugins` | Validates every `plugins/*/plugin.json` and smoke-tests the grammar (`npx tsx scripts/validate-plugins.ts <dir>` for another directory) |

## Where things live

| Path | Contents |
|---|---|
| `shared/src/manifest.ts` | The `plugin.json` schema (zod). Authoritative. |
| `shared/src/grammar/` | Sentence rules: `input.ts`, `transform.ts`, `output.ts`, `params.ts`, `conditions.ts`, `refs.ts` |
| `shared/src/catalog.ts` | Merges manifests and administrator overrides into the catalog the grammar reads |
| `shared/src/handoff.ts` | Renders a plan as Markdown and JSON |
| `server/src/config.ts` | Environment variables and defaults |
| `server/src/app.ts` | Fastify app: routes, headers, static files |
| `server/src/auth/` | Local passwords, cookie sessions, OIDC, trusted-header sign-in |
| `server/src/plans/`, `server/src/helper/`, `server/src/admin/` | The API |
| `server/src/helper/providers/` | Anthropic and OpenAI-compatible providers; `fallback.ts` is the rule-based mode |
| `server/src/db/` | `better-sqlite3` and append-only migrations |
| `server/src/plugins/registry.ts` | Loads plugins from `plugins/` (built in) and `PLUGINS_DIR` (installed) |
| `web/src/` | React app: `workspace/`, `pages/`, `admin/`, `ui/`, `lib/`, `styles/` |
| `plugins/` | Built-in plugins, one directory per plugin |
| `e2e/` | Playwright tests |

## Tests

Unit tests use vitest in `shared/test` (grammar and handoff) and `server/test` (auth, OIDC, plans, helper). The server tests build the app in memory with a temporary data directory (`server/test/helpers.ts`) and drive it with `app.inject`, so no server needs to be running.

```sh
npm test                       # both workspaces
npm test --workspace=shared    # one workspace
```

End-to-end tests run in a real Google Chrome (`channel: "chrome"` in `playwright.config.ts`), so Chrome must be installed. They drive a built app; the default address is http://localhost:3210 and `PW_BASE_URL` overrides it. The first run completes `/setup` with the account in `e2e/helpers.ts`; later runs against the same data directory sign in with it. Screenshots go to `e2e/screenshots/` (or `PW_SHOTS`).

```sh
npm run build
APP_SECRET=dev DATA_DIR=/tmp/pw-data PORT=3210 NODE_ENV=production node server/dist/server.js &
npm run test:e2e
```

This mirrors `.github/workflows/ci.yml`. The e2e tests do not configure an AI provider, so the helper runs in rule-based mode.

## Adding a plugin

A plugin is a directory holding a `plugin.json`, and optionally a `README.md`. The directory name must equal the manifest `id`. Built-in plugins go in `plugins/`; plugins that should not ship with the app go in a directory pointed at by `PLUGINS_DIR` (`plugins-extra/` in `compose.yaml`). The registry reads the directory, so there is no list to register in.

The manifest format is documented in [docs/plugins.md](docs/plugins.md); the schema itself is `shared/src/manifest.ts`. Validate before you open a pull request:

```sh
npx tsx scripts/validate-plugins.ts
```

`shared/test/helpers.ts` loads `gmail`, `monday`, `google-sheets`, `report`, and `core-transforms` for the grammar tests, and `e2e/piecewise.spec.ts` asserts exact sentences built from Gmail and the core transformations. Changing labels or ids in those manifests changes test expectations.

## Adding a transformation

A transformation is an `operation` in a manifest with `"kind": "transforms"`. Add it to `plugins/core-transforms/plugin.json` when it is general, or create a new transforms plugin. This is `dedupe` as shipped:

```json
{
  "id": "dedupe",
  "label": "remove duplicates",
  "category": "Narrow down",
  "params": [{ "id": "field", "label": "judged by", "type": "field", "placeholder": "which field?", "optional": true }],
  "result": { "label": "{source} without duplicates", "fields": { "mode": "same" } }
}
```

The grammar reads `label` after "Take {source} and", emits the `params` as blanks (`shared/src/grammar/params.ts`), and fills `result.label` for the pieces that reference this one. `category` is free text and becomes the group heading in the picker. Set `"ai": true` when a builder would need a language model for the step; the sentence then shows the "AI step" pill. `result.fields` decides which fields downstream pieces see (`shared/src/manifest.ts`, `ResultFieldsSchema`).

Model-backed helpers see every operation through the catalog listing in `server/src/helper/prompt.ts`. The rule-based fallback does not: `server/src/helper/fallback.ts` maps keywords in the thought to a fixed set of operation ids (`summarize`, `translate`, `dedupe`, `classify`, `extract`, `combine`, `count`). Add a line there if the new operation should be proposed without a model.

## Conventions

These are the conventions the code follows. Match them.

- TypeScript with `strict` and `noUncheckedIndexedAccess` (`tsconfig.base.json`). ES modules throughout; server imports use `.js` extensions.
- zod at every boundary: request bodies in the route files, manifests in `shared/src/manifest.ts`, helper output in `server/src/helper/schema.ts`. A `ZodError` becomes a 400 with an `issues` array (`server/src/app.ts`). Other errors go through `HttpError` in `server/src/errors.ts`.
- No ORM. SQL is written by hand against `better-sqlite3`. Migrations in `server/src/db/migrations.ts` are append-only: never edit one that has shipped.
- Hand-written CSS. Colors, fonts, radii, and sizes are custom properties in `web/src/styles/tokens.css`, which also holds the dark theme; use the tokens rather than literal values.
- Copy is sentence case ("New plan", "Break it into pieces", "Create administrator"). Error messages are full sentences addressed to the person.
- Formatting follows `.editorconfig`: two spaces, LF, final newline. There is no linter or formatter in the repo.

## Commits and pull requests

Before you open a pull request, run what CI runs:

```sh
npm run typecheck
npx tsx scripts/validate-plugins.ts
npm test
npm run build
```

Add or update tests with behavior changes: grammar changes belong in `shared/test/grammar.test.ts`, API changes in `server/test/`, and user-visible flows in `e2e/`. If a change alters a command, variable, endpoint, or manifest field, update the document that describes it in the same pull request. Documentation that does not match the code is treated as a bug.
