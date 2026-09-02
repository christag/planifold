# Architecture

Piecewise is one Node process, one SQLite file, and one React bundle. This document explains how the pieces fit: the planning model, the grammar that turns slot values into sentences, the database, the request path when a person fills a blank, the AI helper, handoff generation, the web app, and the deployment shape.

Paths below are relative to the repository root. The three workspaces are `shared/` (types, manifest schema, grammar, handoff), `server/` (Fastify API), and `web/` (React app).

```
                 browser                                   server process (node)
 ┌──────────────────────────────────┐        ┌──────────────────────────────────────────────┐
 │ React app (web/)                 │        │ Fastify (server/src/app.ts)                  │
 │  zustand stores                  │  HTTP  │  auth plugin ── cookie session / OIDC /      │
 │  grammar from @piecewise/shared ─┼───────►│              trusted header                  │
 │  renders sentences instantly     │  JSON  │  /api/plans, /api/helper, /api/admin, ...    │
 └──────────────────────────────────┘        │  static files (web/dist) + SPA fallback      │
                                             │                                              │
                                             │  PluginRegistry ◄── plugins/  PLUGINS_DIR    │
                                             │  grammar from @piecewise/shared (validates)  │
                                             │  HelperService ──► Anthropic / OpenAI /      │
                                             │                    OpenAI-compatible server  │
                                             │  better-sqlite3 ──► DATA_DIR/piecewise.sqlite│
                                             └──────────────────────────────────────────────┘
```

## The planning model

A plan is a thought plus a small set of pieces. Every piece has exactly one kind (`shared/src/types.ts`):

```ts
export type PieceKind = "input" | "transform" | "output";
```

The user-facing labels are Input, Transformation, and Expected output. A piece is one sentence with blanks. Each blank is a slot, and a slot holds one of four values:

```ts
export type SlotValue =
  | { kind: "option"; id: string }
  | { kind: "text"; text: string }
  | { kind: "ref"; pieceId: string }
  | { kind: "unsure"; note?: string };
```

`option` is an id from the catalog (an integration, object, field, operator, operation, or enum value). `text` is something the person typed. `ref` points at another piece. `unsure` is a loose end the person chose to leave open, with an optional note.

Pieces refer to each other through `ref` slots. A transformation's `source` slot is an input or another transformation. An output's `source` slot is any input or transformation. Outputs are never referenced. The grammar enforces this when it builds the option list for a `ref` slot (`shared/src/grammar/refs.ts`, `refOptions`): it offers only non-output pieces that are not already downstream of the current piece (`descendantsOf`). So a plan is a directed acyclic graph by construction, not by a separate validation step. To label the candidates in that menu, `refOptions` calls `summarize`, a lite build in which a piece's own reference menus list only the pieces it already points at; that keeps the cost of a full build at O(pieces × chain depth) instead of fanning out across every sibling. `buildSentence` also keeps a `building` set on the grammar context as a guard against cyclic data that reached the database some other way.

The sentences grow as the blanks are filled. These are taken verbatim from `shared/test/grammar.test.ts`:

```
From [somewhere]
I want to get [what?] from Gmail
I want to get emails from Gmail where [which ones?]
I want to get emails from Gmail where subject contains “pasta”.
I want to get all emails from Gmail from the last 30 days, every morning.

Take [a piece]
Take emails from Gmail about “pasta” and summarize each one in one line.

Send summaries of all emails from Gmail to Gmail as an email to each person in contacts from Gmail about “Friends”.
Create an item in Monday.com from summaries of all emails from Gmail on the board “Roadmap”.
```

Every noun in those sentences (Gmail, emails, subject, summarize, an email, Monday.com, an item, the board) comes from a plugin manifest, not from code.

## The catalog and plugin manifests

The grammar reads a `Catalog` (`shared/src/catalog.ts`): enabled integrations with their objects and actions, plus transform operations, with administrator overrides already applied. `buildCatalog(manifests, overrides)` drops disabled plugins, removes disabled objects, actions, and operations, and replaces manifest guidance with the organization's guidance when set. An integration keeps the `input` role only if it still has objects and the `output` role only if it still has actions.

Manifests are validated with zod against `PluginManifestSchema` in `shared/src/manifest.ts`, which is the authoritative schema. An excerpt from `plugins/gmail/plugin.json`:

```json
{
  "id": "gmail",
  "kind": "integration",
  "roles": ["input", "output"],
  "objects": [
    {
      "id": "emails",
      "label": "emails",
      "singular": "email",
      "timeField": "date",
      "fields": [
        { "id": "from", "label": "sender", "type": "email" },
        { "id": "subject", "label": "subject", "type": "string" },
        { "id": "date", "label": "date received", "type": "datetime" }
      ]
    }
  ],
  "actions": [
    {
      "id": "send_email",
      "label": "an email",
      "params": [
        { "id": "to", "label": "to", "type": "ref-or-text", "placeholder": "who?", "refLabel": "each person in {piece}" }
      ]
    }
  ]
}
```

On the server, `PluginRegistry` (`server/src/plugins/registry.ts`) scans two directories: the built-in `plugins/` and `PLUGINS_DIR`. Each subdirectory must contain `plugin.json`; the manifest `id` must equal the directory name. Manifests that fail to parse are recorded in `registry.problems` and skipped. Overrides come from the `plugin_settings` table. The registry caches the built catalog in memory and invalidates it when settings change or on reload.

## The grammar engine

The grammar lives in `shared/src/grammar/`. It is a pure function from a piece's slot values (plus the catalog and the other pieces) to a `Sentence`:

```ts
export interface Sentence {
  tokens: Token[];        // text tokens and slot tokens, in reading order
  status: PieceStatus;    // "empty" | "partial" | "complete"
  label: string;          // user's name for the piece, or autoLabel
  autoLabel: string;
  text: string;           // plain text; blanks written as [placeholder]
  missing: string[];      // required slot ids that are empty or unsure
  unsure: LooseEnd[];
  refs: string[];         // piece ids this piece reads from
  visited: string[];      // every slot id the grammar reached
  invalid: string[];      // stored values that no longer fit the options
  ai: boolean;            // involves an AI step
}
```

`buildSentence(piece, ctx)` in `sentence.ts` creates a `Builder` (`builder.ts`) and calls `buildInput`, `buildTransform`, or `buildOutput` by kind. Each of those walks the sentence left to right. For every blank it calls `b.resolve(spec)` with a `SlotSpec` (id, placeholder, options, whether free text is allowed, whether it is optional). `resolve` checks the stored value against the spec: an `option` must be one of the offered ids, a `ref` must be one of the offered pieces, `text` is accepted only when the spec allows it. A value that does not fit is recorded in `invalid` and treated as empty. `emit` pushes the slot token. Optional slots (time range, trigger, outcome, optional params) are shown only once every required slot before them is filled (`b.settled`).

Slot ids are stable strings, so the helper and the client can name them:

| Piece kind | Slot ids |
|---|---|
| input | `integration`, `object`, `qualifier`, `filter.N.field`, `filter.N.op`, `filter.N.value`, `timeRange`, `trigger` |
| transform | `source`, `operation`, `p.<param>`, `p.<param>.N` (list params), `p.<param>.N.field/op/value` (condition params) |
| output | `integration`, `action`, `source`, `p.<param>…`, `outcome` |

`params.ts` maps a manifest `Param` to slot specs by type: `text`, `number`, `date`, `enum`, `field`, `ref`, `ref-or-text`, `fields`, `texts`, `condition`. `conditions.ts` holds the operator table per field type (for example `string` gets `contains`, `not_contains`, `is`, `is_not`, `starts_with`, `is_empty`, `not_empty`; `date` gets `in_last`, `after`, `before`, `today`, `on`) and the `__all__` option that means "no filter". `fields.ts` (`fieldsOf`) computes which fields a piece's result carries by following `source` references and applying each operation's `result.fields` rule (`same`, `none`, `replace`, `extend`, plus `fromParam`, `enumFromParam`, `pickFromParam`, `withRef`). That is how a `field` param on a later piece can offer the `summary` column that a `summarize` step added.

Two functions keep stored state consistent with the grammar:

- `withSlot(piece, slotId, value)` returns a copy with one slot changed or cleared.
- `cleanPiece(piece, ctx)` builds the sentence, keeps only slots that are in `visited` and not in `invalid`, and repeats up to three passes because removing one value can change what is reachable. A piece therefore never carries a filter clause for an object it no longer names.

`analyzePlan(pieces, catalog)` in `plan.ts` builds every sentence once, then derives:

- `edges`: one `{ from, to }` per `ref`, used by the map view and the handoff.
- `looseEnds`: every `unsure` slot with its piece label.
- `counts` per kind.
- `nudges`: short observations with a level (`info`, `warn`, `done`) and an id. The rules are: `start` when there are no pieces; `blank:<id>` listing what a piece still needs; `unused:<id>` (warn) when an input or transformation is not read by anything; `vague:<id>` (warn) when an `ask_ai` instruction is under six words; `no-input` and `no-output` (warn); `ai` when any step needs a model; `loose` when loose ends remain; `ready` (done) when everything is complete.
- `ready`: true only when there is at least one input and one output, every piece is complete, there are no loose ends, and no warn-level nudge remains.

The same grammar runs in both places. `@piecewise/shared` exports its TypeScript source directly (`"main": "./src/index.ts"`); Vite compiles it into the web bundle and esbuild bundles it into `server/dist/server.js`. The browser calls `buildSentence`, `cleanPiece`, and `analyzePlan` to render and react without a round trip. The server calls `cleanPiece` on every write and `reconcilePlan` after structural changes, so nothing reaches the database that the grammar would not produce.

## Data model

All tables are created by the single migration in `server/src/db/migrations.ts`. The file is append-only; `server/src/db/index.ts` records applied versions in `schema_migrations` and opens the database with `journal_mode = WAL`, `foreign_keys = ON`, and `busy_timeout = 5000`.

| Table | Purpose | Notes |
|---|---|---|
| `users` | Accounts | `role` is `user`, `integration_admin`, or `app_admin`; `password_hash` is scrypt or null; `auth_source` is `local`, `oidc`, or `trusted-header` |
| `sessions` | Cookie sessions | Random id, `expires_at`; cascade on user delete |
| `plans` | One row per plan | `thought`, `facts` (JSON array), `status` in `draft`, `ready`, `handed_off`; `brief` holds the generated build brief |
| `pieces` | One row per piece | `kind`, `position`, `slots` (JSON object of `SlotValue`), `label`, `notes`; cascade on plan delete |
| `helper_messages` | Helper conversation per plan | `role` user or assistant, `content`, `payload` (JSON: suggestions, questions, source, model, notice) |
| `llm_providers` | Configured AI providers | `kind` in `anthropic`, `openai`, `openai_compatible`; `api_key_enc` sealed with AES-256-GCM; one row has `is_active = 1` |
| `plugin_settings` | Per-plugin overrides | `enabled`, `owner_id`, `guidance`, `setup_notes`, `overrides` (JSON: disabled objects, actions, operations) |
| `settings` | Key-value organization settings | `orgName`, `orgGuidance`, `preferredBuilder` |
| `audit_log` | Administrative and plan events | `actor_email`, `action`, `target`, `details` (JSON) |
| `oidc_flows` | In-flight OIDC logins | `state`, `nonce`, `code_verifier`, `redirect_to`; rows older than 15 minutes are purged on the next start |

Slot values are stored as a JSON blob per piece rather than one row per slot. The grammar is the only reader that interprets them, and it tolerates stale keys because `cleanPiece` prunes them.

API keys are encrypted with `SecretBox` (`server/src/crypto.ts`): AES-256-GCM with a key derived from `APP_SECRET` by scrypt. If `APP_SECRET` changes, stored keys cannot be opened and the admin page shows them as unreadable.

## Filling a blank: request flow

This is the path from a click in a slot menu to a saved piece.

```
 SlotMenu.choose(option)
     │
     ▼
 usePlan.setSlot(pieceId, slotId, value)            web/src/lib/planStore.ts
     │  withSlot → cleanPiece (browser grammar)
     │  setPieces(optimistic) → analyzePlan
     │  openSlot = nextBlank(); justCompleted?
     │
     │  PATCH /api/plans/:id/pieces/:pid  { slots }
     ▼
 plans/routes.ts
     │  zod: slot ids /^[a-zA-Z0-9_.-]{1,80}$/, values ≤ 2000 chars
     │  cleanPiece (server grammar, same code) → dropped = keys removed
     │  savePiece
     │  reconcilePlan: cleanPiece every piece, persist any that changed, repeat until stable
     │
     │  200 { piece, pieces, dropped }
     ▼
 usePlan.setPieces(res.pieces)                       server state replaces optimistic state
     (on error: toast, then reload the plan)
```

The optimistic step is what makes the sentence feel instant: the next blank opens before the network round trip completes. The server step is what keeps the plan honest: it does not trust the client's slot map, it re-runs the same grammar, and it reconciles the whole plan because a changed `source` reference can invalidate a downstream piece's field choices; reconciliation repeats until no piece changes, so an invalidation cascades through the whole chain. The client then discards its optimistic state in favor of the server's.

Creating a piece (`POST /api/plans/:id/pieces`) and deleting one (`DELETE …/pieces/:pid`) go through the same `cleanPiece` and `reconcilePlan` calls. Deleting a piece that others reference leaves their `source` slots invalid; reconciliation drops those values and the sentences show the blank again.

Plan-scoped endpoints:

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/catalog` | The catalog the grammar uses |
| GET, POST | `/api/plans` | List own plans (`?all=1` for app admins), create a plan with one empty input |
| GET, PATCH, DELETE | `/api/plans/:id` | Read (plan, pieces, messages), update title/thought/facts/status, delete |
| POST | `/api/plans/:id/pieces` | Add a piece |
| PATCH, DELETE | `/api/plans/:id/pieces/:pid` | Update slots/label/notes, remove |
| POST | `/api/plans/:id/pieces/reorder` | Set positions |
| POST | `/api/plans/:id/pieces/apply` | Apply a helper suggestion through the grammar |
| GET | `/api/plans/:id/handoff` | Handoff document (JSON and Markdown) |
| POST | `/api/plans/:id/helper` | Ask the helper (30 requests per minute) |
| DELETE | `/api/plans/:id/helper` | Clear the conversation |
| POST | `/api/plans/:id/brief` | Write or rewrite the build brief (10 per minute) |
| GET | `/api/helper/status` | Whether a provider is active, and which |

`loadPlanFor` (`server/src/plans/access.ts`) allows the owner or any `app_admin`. Authentication endpoints live under `/api/auth/*`, integration-owner endpoints under `/api/integrations`, and app-admin endpoints under `/api/admin/*` (users, providers, settings, plugins, audit).

## The helper pipeline

The helper is always present. It proposes; it never writes to a plan on its own. Everything it suggests goes back through the grammar before a person can apply it. The code is in `server/src/helper/`.

```
 POST /api/plans/:id/helper { message, intent, focus }
     │
     ▼
 HelperService.respond                               helper/service.ts
     │  catalog ← registry; org ← settings; row ← active llm_provider
     │
     ├─ provider active ──► systemPrompt(catalog, org)          helper/prompt.ts
     │                       stateMessage(plan, pieces, focus, intent)
     │                       provider.structured(HelperResponseSchema, …)
     │                       on error: fallbackResponse(reason: "failed") + notice
     │
     └─ no provider ──────► fallbackResponse(…)                  helper/fallback.ts
     │
     ▼
 review each suggestion: applySuggestion on a copy → preview, applied, dropped, valid
     │
     ▼
 store user + assistant messages; merge `remember` into plan.facts
```

The system prompt is deterministic for a given catalog and organization so that it can be cached by the provider. It contains: what Piecewise is and is not; the three piece kinds with example sentences; the rules (one piece at a time, propose rather than decide, never invent ids); the full slot-id scheme and the operator table; every enabled integration with its objects, fields, actions, params, guidance, and access notes; every operation; and the organization's guidance under a heading that says to follow it. If `preferredBuilder` is set, the prompt says to steer toward it.

The state message is the volatile part: the plan title, thought, and facts; every piece with its id, status, current sentence text, notes, and up to two required blanks (all blanks for the focused piece, each with up to 40 options); the focused piece and slot with its help text; the grammar's nudges under "OBSERVATIONS FROM THE GRAMMAR"; and a task line that depends on the intent (`chat`, `breakdown`, `slot`, `review`). The last twelve stored messages are sent as history, followed by one user message made of the state and `PERSON SAYS: …`.

The provider must return JSON matching `HelperResponseSchema` (`helper/schema.ts`):

```ts
{
  message: string;                     // plain text for the person
  suggestions: Array<{
    title: string;
    pieceId: string | null;            // fill this piece, or null for a new one
    kind: "input" | "transform" | "output";
    slots: Array<{ id: string; type: "option" | "text" | "ref"; value: string }>;
    why: string;
  }>;
  questions: string[];                 // only the person can answer these
  remember: string[];                  // facts a builder must know later
}
```

Three provider implementations share one interface (`providers/types.ts`: `structured`, `text`, `test`). `anthropic.ts` uses `client.messages.parse` with `zodOutputFormat` and marks the system prompt with `cache_control: ephemeral`. `openai.ts` covers two kinds: `openai` uses the Responses API (`client.responses.parse` with `zodTextFormat`), and `openai_compatible` uses Chat Completions with `zodResponseFormat`, which is what gateways and self-hosted servers speak. Provider errors are mapped to `HelperError` messages that name the fix (wrong key, unknown model, rate limit).

`applySuggestion` (`helper/apply.ts`) is the validation step. It takes the target piece (existing, or an empty one of the suggested kind) and the suggested slots, then loops: build the sentence, find the first suggested slot the grammar currently offers, convert it (`ref` by piece id; `option` by id, then by normalized label; a `text` value only when the slot allows free text), apply it, and rebuild. Slots the grammar never reaches, and values that match nothing, are reported in `dropped`. The result is passed through `cleanPiece`. `review` in the service runs this on a copy to produce a `preview` sentence and a `valid` flag (at least one slot applied) for the suggestion card. When the person clicks Apply, the client posts the same slots to `/api/plans/:id/pieces/apply`, and the server runs `applySuggestion` again against the current plan before inserting or saving. A suggestion with a wrong id therefore cannot reach the database.

`fallback.ts` is the rule-based mode used when no provider is active or the call fails. It is limited by design. For `breakdown` it scores integrations by a keyword alias table (for example `gmail` matches "email", "inbox", "contacts"), pulls a topic out of the thought with a regular expression on words like "about" or "containing", guesses one operation from substrings such as "summar" or "translat", and picks an output integration, preferring `report` unless the thought contains a send-like word. For `slot` it lists the slot's options and the help text and suggests an option whose label appears in the thought. For `chat` and `review` it repeats the grammar's nudges and loose ends. It does not understand the thought; it matches words. Its message says so, and the response carries `source: "rules"`.

## Handoff and the build brief

`buildHandoff(plan, pieces, catalog, opts)` in `shared/src/handoff.ts` runs `analyzePlan` and produces a `HandoffDocument`: the plan header; every piece with a number within its kind (`Input 1`, `Transformation 1`, `Expected output 1`), label, final sentence text, status, notes, loose ends, `dependsOn` numbers, and an `ai` flag; the edges; the integrations the plan touches with their guidance and access notes; the organization's guidance and preferred builder; the stored brief; and a timestamp. `renderHandoffMarkdown` writes it as a document with these sections in order: title and quoted thought, status line, "Things to remember", one section per piece kind, "Loose ends", "How this should be built" (preferred builder, organization guidance, per-integration guidance and access), and "Build brief".

`GET /api/plans/:id/handoff` returns both the JSON document and the Markdown. The Handoff view offers copy, `.md` download, and `.json` download. "Mark as handed off" is enabled only when `analysis.ready` is true; "Reopen as draft" reverses it.

The build brief is the one piece of prose the model writes end to end. `POST /api/plans/:id/brief` calls `HelperService.writeBrief`, which renders the handoff Markdown, wraps it with `briefPrompt`, and calls `provider.text`. The prompt fixes the audience (an engineer or agent who has not talked to the planner), the length (under 450 words), and the sections (Summary, Steps, Data and access needed, Open questions, Suggested build approach). If the organization has a preferred builder, the prompt says to recommend it unless the plan cannot be built that way, and to say why if so. Organization guidance is passed through. The result is stored in `plans.brief`. Without a provider, or when the call fails, `templateBrief` assembles the same five sections from the plan itself (sentence per step, integrations with setup notes, loose ends and warn nudges as open questions), and the response says `source: "rules"`.

## The web app

`web/` is React 19 with react-router-dom, zustand for state, and `@xyflow/react` for the map. There is no server-side rendering; the server serves `web/dist` as static files.

Two zustand stores:

- `useApp` (`web/src/lib/store.ts`): `user`, `authConfig`, `catalog`, `helperStatus`, `theme`, `toasts`. `boot()` fetches `/api/auth/config` and `/api/auth/me` in parallel, then loads the catalog and helper status once a user is present.
- `usePlan` (`web/src/lib/planStore.ts`): `plan`, `pieces`, `messages`, `analysis` (the `PlanAnalysis` computed in the browser), `view` (`pieces`, `map`, `handoff`), `focusId`, `openSlot`, `helperOpen`, `planSheetOpen`, `helperBusy`, `saving`, `justCompleted`. Every mutation updates local state first, calls the API, then replaces local state with the response. `setPieces` recomputes `analysis` every time.

Routes (`web/src/App.tsx`): `/setup`, `/login`, `/` (plans list), `/new`, `/plans/:id` (the workspace), `/integrations` (integration admins and app admins), `/account`, `/admin/*` (app admins). `RequireAuth` redirects to `/setup` when no user exists yet, otherwise to `/login`, and shows a change-password gate when `mustChangePassword` is set.

The workspace (`web/src/workspace/`):

| Component | Role |
|---|---|
| `PlanPage` | Header with title, readiness pill, view switcher; three columns on desktop: `Rail`, the main view, `HelperPanel`. On mobile the rail and helper become bottom sheets and a chip strip lists the pieces. A plan opened with `state.fresh` fires one automatic `breakdown` request. |
| `Rail` | The thought (editable), "Things to remember" (the facts list), pieces grouped by kind with add buttons, and loose ends. Clicking a loose end focuses that piece and opens that slot. |
| `FocusCard` | One piece at a time: kind and index, status pill, the `Sentence`, rename, notes for the builder (debounced save), "Help me with this piece", and previous/next navigation. |
| `Sentence` | Renders tokens. Text tokens are spans; slot tokens are buttons whose class encodes state (`empty`, `filled`, `filled ref`, `filled text`, `unsure`, `empty optional`). Unfilled optional blanks are moved to the end so the period follows the last real word. Newly appeared tokens get a `tok-new` class. |
| `SlotMenu` | The menu behind a blank. Options grouped by `group`, a search box when there are more than seven, a text field when the spec allows it (typed as `date` or `number` when the spec says so), and a footer with "I'm not sure yet" (stores an `unsure` value with an optional note), "Help me with this" (sends a `slot` intent with the piece and slot id), and Clear. |
| `HelperPanel` | The top three nudges, the message list, suggestion cards with Apply (state remembered in `sessionStorage` per message), "Only you can answer" questions, and the compose box. Shows the active model or "rules only". |
| `MapView` | Read-only React Flow graph. Nodes are placed in three columns by kind (`x = column * 340`, `y = row * 170`); edges come from `analysis.edges`. Clicking a node focuses it in the Pieces view. |
| `HandoffView` | Fetches `/api/plans/:id/handoff` whenever the plan or pieces change, renders the document, and hosts the brief button. |

`Popover` (`web/src/ui/primitives.tsx`) is the one overlay primitive. On desktop it is anchored below (or above, when there is no room) the element that opened it; on narrow screens, or when passed `sheet`, it is a bottom sheet. It is portaled to `document.body`, closes on Escape and outside clicks, and returns focus to the anchor. `SlotMenu`, the plan and piece option menus, the account menu, and the mobile rail and helper all use it.

`web/src/lib/api.ts` is a thin fetch wrapper: same-origin credentials, JSON bodies, `ApiError` with the server's `code` and zod `issues`. A 401 from any non-auth endpoint clears the user so `RequireAuth` redirects to login.

## Deployment shape

One process serves everything. `server/src/index.ts` loads config, builds the Fastify app, and listens. `server/build.mjs` bundles `server/src/index.ts` and the shared package into `server/dist/server.js` with esbuild; runtime dependencies stay external and are installed with `npm ci --omit=dev --workspace=server`.

`server/src/app.ts` registers, in order: a global rate limit (600 requests per minute per client), the auth plugin (cookie parsing, session lookup, same-origin check for state-changing `/api/` requests, trusted-header fallback), `/api/health`, then the auth, plans, helper, integrations, and admin routes. Unknown `/api/*` paths return 404 JSON. If `WEB_DIST_DIR/index.html` exists, `@fastify/static` serves the build at `/`, and any other `GET` that is not under `/api/` returns `index.html` so client-side routes work. An `onSend` hook adds `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`, a `Permissions-Policy`, a Content-Security-Policy on non-API responses (`default-src 'self'`, inline styles allowed, no remote scripts), `Cache-Control: no-store` on API responses, and a one-year immutable cache on `/assets/`.

Configuration is read once from the environment in `server/src/config.ts`; every value has a default so `npm start` works with no setup. The variables that shape the deployment:

| Variable | Default | Meaning |
|---|---|---|
| `PORT`, `HOST` | `3000`, `0.0.0.0` | Listen address |
| `BASE_URL` | unset | Public origin; required for OIDC; when it starts with `https://`, cookies default to secure |
| `DATA_DIR` | `./data` | Created if missing; holds the database and the generated secret |
| `DB_PATH` | `DATA_DIR/piecewise.sqlite` | SQLite file |
| `APP_SECRET` | generated into `DATA_DIR/.app-secret` | Key for API-key encryption; set it explicitly in production |
| `BUILTIN_PLUGINS_DIR` | first existing of `../../plugins`, `../plugins`, `./plugins` relative to the bundle or cwd | Built-in plugins |
| `PLUGINS_DIR` | unset | Extra plugins, loaded after the built-ins |
| `WEB_DIST_DIR` | first existing of `../../web/dist`, `../web`, `./web/dist` | Static files; if absent, only the API is served |
| `TRUST_PROXY` | `false` | Pass through to Fastify when behind a reverse proxy |
| `SESSION_DAYS` | `14` | Cookie and session lifetime |
| `LOG_LEVEL` | `info` (`silent` under `NODE_ENV=test`) | pino level |

Authentication variables (`AUTH_LOCAL`, `OIDC_*`, `AUTH_TRUSTED_*`, `BOOTSTRAP_ADMIN_*`) are listed in `server/src/config.ts` and `.env.example`.

The `Containerfile` is a two-stage build on `node:22-bookworm-slim`. The runtime stage sets `NODE_ENV=production`, `DATA_DIR=/data`, and `PLUGINS_DIR=/plugins`, copies `server/dist`, `web/dist`, and `plugins/`, runs as the `node` user, declares `/data` as a volume, and has a health check against `/api/health`. `compose.yaml` mounts a named volume at `/data` and `./plugins-extra` read-only at `/plugins`. `deploy/piecewise.container` is a Podman Quadlet unit for the same image with an environment file at `~/.config/piecewise/piecewise.env`. CI (`.github/workflows/ci.yml`) runs typecheck, plugin validation, unit tests, a production build, and Playwright end-to-end tests against the built server, then pushes a multi-arch image to `ghcr.io` on pushes to `main` and version tags.

## Limitations to know about

- Storage is SQLite only, through `better-sqlite3`. There is no adapter for another database.
- The design assumes one process. The plugin registry caches the catalog in memory and invalidates it only in the process that changed the settings. OIDC flow state is in the database rather than in memory, but nothing else in the app is arranged for several instances sharing one file.
- The rule-based helper matches keywords. It cannot interpret a thought it has not seen words for, and its suggestions are guesses the person must check. A configured model is needed for real suggestions and for a written build brief.
- OIDC is tested against `oauth2-mock-server` in `server/test/oidc.test.ts`, not against a specific vendor's implementation. It uses the standard authorization-code flow with PKCE through `openid-client`, and it needs the `email` claim (or the userinfo endpoint) to create an account.
- Piecewise does not run anything. The output is a document and a brief; the build happens elsewhere.
