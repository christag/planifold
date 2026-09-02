# Writing a plugin

A plugin describes one system to Piecewise: what can be read from it, what can be sent to it, and how the organization wants it used. It is a directory holding a `plugin.json` and, optionally, a `README.md`. There is no code. The grammar engine builds every sentence a person sees from the manifest, so wording is the work.

```
plugins/
  monday/
    plugin.json
    README.md      # optional, shown to administrators
```

The directory name must equal the manifest `id`. Built-in plugins live in `plugins/` in the repository (and `/app/plugins` in the image). Your own go in the directory named by `PLUGINS_DIR` (`/plugins` in the image; `compose.yaml` mounts `./plugins-extra` there). Plugins load at start and again on "Reload from disk" in Admin → Integrations. A manifest that fails validation is skipped and listed under problems on that page and in `GET /api/health`.

Validate before shipping:

```sh
npm run validate-plugins                 # every plugins/*/plugin.json
npx tsx scripts/validate-plugins.ts ./plugins-extra   # a different directory
```

The schema is `shared/src/manifest.ts`. Everything below is derived from it.

## Two kinds of plugin

| `kind` | Describes | Appears as |
|---|---|---|
| `integration` (default) | A system: its `objects` (things you can read) and `actions` (things you can create or send) | Choices for the *integration* blank of inputs and expected outputs |
| `transforms` | `operations` that change information on its way through | Choices for the *do what?* blank of transformations |

An integration declares `roles`: `["input"]`, `["output"]`, or both. A plugin with the `input` role needs at least one object; with the `output` role, at least one action.

## Top-level fields

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Lowercase letters, digits, dashes. Must match the directory name. |
| `name` | yes | Shown in sentences: "from **Gmail**", "to **Monday.com**". For generic systems use a phrase: "A database", "A shared folder". |
| `version` | yes | Any string; shown to administrators. |
| `description` | yes | One line shown in the integration menu. |
| `category` | no | Groups the menu: "Email & calendar", "Chat", "Spreadsheets & files", "Work management", "Docs & wikis", "IT & support", "HR", "CRM & sales", "Data & APIs". |
| `icon` | no | One emoji or a one- or two-letter mark. |
| `website` | no | Developer documentation URL, linked from the admin page. |
| `kind` | no | `integration` (default) or `transforms`. |
| `roles` | integration | `input`, `output`, or both. |
| `objects` | input role | See below. |
| `actions` | output role | See below. |
| `operations` | transforms | See below. |
| `guidance` | no | Default instruction for the AI helper about how this system is normally used. Administrators can replace it. Printed on every handoff that touches the plugin. |
| `setup.notes` | no | How to get access: who to ask, what to request. Also printed on handoffs. |
| `setup.docsUrl` | no | Link to the setup documentation. |

Ids inside a manifest (`objects[].id`, `fields[].id`, `actions[].id`, `params[].id`, `operations[].id`) are lowercase snake_case: `^[a-z][a-z0-9_]*$`.

## Objects: what an input can read

```json
{
  "id": "emails",
  "label": "emails",
  "singular": "email",
  "description": "Messages in a mailbox, newest first.",
  "timeField": "date",
  "fields": [
    { "id": "from", "label": "sender", "type": "email" },
    { "id": "subject", "label": "subject", "type": "string" },
    { "id": "body", "label": "body", "type": "text" },
    { "id": "date", "label": "date received", "type": "datetime" },
    { "id": "label", "label": "label", "type": "string", "description": "A Gmail label such as Inbox, Starred, or one you made." },
    { "id": "unread", "label": "unread", "type": "boolean" },
    { "id": "attachment", "label": "attachment", "type": "attachment" }
  ]
}
```

| Field | Meaning |
|---|---|
| `label` | Plural, lowercase. Fills the *what?* blank: "I want to get **emails** from Gmail". |
| `singular` | Used where one item is meant. |
| `fields` | What people can filter on. Each has `id`, `label`, `type`, optional `description`, and `values` for `enum`. |
| `allowCustomFields` | Let people type a field name that is not listed. Defaults to `true` when `fields` is empty (spreadsheets, databases). |
| `filterable` | Default `true`. Set `false` for objects that cannot be narrowed. |
| `timeField` | The id of a `date` or `datetime` field. Enables the optional "from the last 7 days" blank. |
| `qualifier` | A container the object lives in that the person must name: `{ "label": "in the spreadsheet", "placeholder": "which spreadsheet?" }`. Renders as "I want to get rows from Google Sheets **in the spreadsheet “Budget 2026”** where …". Use it when the system's API lists one container at a time; if the system searches globally, make the container a filterable field instead. |

### Field types and their operators

The operator menu depends on the field type (`shared/src/grammar/conditions.ts`):

| Type | Operators | Value blank |
|---|---|---|
| `string`, `text`, `url` | contains, does not contain, is, is not, starts with, is empty, is not empty | typed text |
| `person`, `email` | is, is not, contains, is me | typed text |
| `number` | is, is not, is more than, is less than | typed number |
| `date`, `datetime` | is in the last, is after, is before, is today, is on (`date` only) | period menu (24 hours, 7 days, 30 days, 90 days, 12 months) or a typed date |
| `boolean` | is true, is false | none |
| `enum` | is, is not | one of `values` |
| `attachment` | is present, is missing | none |

`enum` fields must list `values`. Use the product's real status names: `["Not started", "Working on it", "Stuck", "Done"]`.

## How an input sentence renders

The grammar (`shared/src/grammar/input.ts`) grows the sentence as blanks fill:

```
From [somewhere]
I want to get [what?] from Gmail
I want to get emails from Gmail where [which ones?]
I want to get emails from Gmail where subject [is…]
I want to get emails from Gmail where subject contains [what?]
I want to get emails from Gmail where subject contains “pasta”.
I want to get emails from Gmail where subject contains “pasta” from the last 30 days, every morning.
```

- The first *which ones?* menu offers **all** ("I want to get all emails from Gmail.") as well as the fields.
- After a complete condition, an optional **and…** blank offers another clause: "where status is Stuck and due date is in the last 7 days".
- Once the required blanks are filled, two optional blanks appear: a time range (only when the object has a `timeField`) and a schedule ("once, when I run it", "whenever a new one appears", "every morning", …). Their values are kept even while an earlier blank is being changed.
- The period is added only when every required blank is filled.

## Actions: what an expected output can do

```json
{
  "id": "send_email",
  "label": "an email",
  "description": "Send mail. Choose whether each item becomes its own message.",
  "params": [
    { "id": "to", "label": "to", "type": "ref-or-text", "placeholder": "who?", "refLabel": "each person in {piece}" },
    { "id": "subject", "label": "with the subject", "type": "text", "placeholder": "subject line", "optional": true },
    { "id": "grouping", "label": "sent as", "type": "enum", "values": ["one email per item", "one email with everything"], "optional": true }
  ]
}
```

| Field | Meaning |
|---|---|
| `label` | A noun phrase: "an email", "a new item", "new rows". |
| `pattern` | `send` (default): "**Send** *the summaries* to Gmail as an email …". `create`: "**Create** an item in Monday.com from *the summaries* …". Use `create` for records, tickets, pages, files; `send` for delivering data or changing existing records. |
| `verb` | Overrides the first word: "Post", "Add", "Save", "Apply", "Log". Defaults to Send or Create by pattern. |
| `source` | `required` (default), `optional`, or `none` when the action takes no data from another piece. |
| `params` | Blanks after the action, in order. Required ones first, then optional. |

Rendered (`shared/src/grammar/output.ts`):

```
To [somewhere]
Send [what?] to Gmail as [what kind of thing?]
Send summaries of emails from Gmail about “pasta” to Gmail as an email to [who?]
Send summaries of emails from Gmail about “pasta” to Gmail as an email to each person in contacts from Gmail about “Friends”.
Create an item in Monday.com from summaries of emails from Gmail about “pasta” on the board “Roadmap”.
```

Every output also gets an optional **how will I know it worked?** blank: ", and I’ll know it worked when “every friend gets exactly one email”." That sentence becomes the acceptance check on the handoff.

## Params

Params are the blanks of an action or an operation.

| Field | Meaning |
|---|---|
| `id` | Slot id becomes `p.<id>` (list params: `p.<id>.0`, `p.<id>.1`, …; conditions: `p.<id>.0.field`, `.op`, `.value`). |
| `label` | The words right before the blank: "to", "in the channel", "on the board". Use `""` for none. |
| `type` | See the table below. |
| `placeholder` | Shown inside the empty blank: "who?", "which spreadsheet?". |
| `values` | Required for `enum`. |
| `optional` | Optional params render as a quiet "+ label" chip once the required blanks are filled. Leaving one blank is a valid answer. |
| `suffix` | Words after the value: "from each one". |
| `refLabel` | How a referenced piece reads in this position: "each person in {piece}". |
| `description` | One line of help at the top of the blank's menu. |

| `type` | Menu | Notes |
|---|---|---|
| `text`, `number`, `date` | typed value | `number` and `date` use matching inputs |
| `enum` | one of `values` | |
| `field` | a field of the source piece | Typed names allowed when the source allows custom fields |
| `fields` | several fields, joined with "and" | An **and…** blank follows each filled entry |
| `texts` | several typed values, joined with "and" | "pull out “the recipe name” and “the cook time” from each one" |
| `condition` | field, operator, value clauses like an input filter | Against the source piece's fields |
| `ref` | another input or transformation | Never a piece that already reads from this one |
| `ref-or-text` | another piece, or typed text | For recipients, channels, targets |

## Operations: what a transformation can do

Operations belong to a plugin with `"kind": "transforms"`. The built-in set is `plugins/core-transforms/plugin.json`.

```json
{
  "id": "summarize",
  "label": "summarize each one",
  "category": "Change each one",
  "ai": true,
  "params": [{ "id": "length", "label": "", "type": "enum", "values": ["in one line", "in a short paragraph", "as three bullet points"] }],
  "result": {
    "label": "summaries of {source}",
    "fields": { "mode": "extend", "fields": [{ "id": "summary", "label": "summary", "type": "text" }] }
  }
}
```

| Field | Meaning |
|---|---|
| `label` | Verb phrase after "Take *X* and": "summarize each one", "keep only the ones where". |
| `category` | Groups the menu: "Narrow down", "Change each one", "Combine". |
| `ai` | Marks a step that needs a language model when built. The piece shows an "AI step" tag and the handoff says so. |
| `params` | As above. |
| `result.label` | Names the result for downstream menus. `{source}` is the source piece's label; `{paramId}` inserts a param's value (field labels for `field` and `fields` params, values joined with commas for lists). "summaries of {source}" → "summaries of emails from Gmail about “pasta”". |
| `result.fields` | What fields the result has, so later pieces can filter and pick. See below. |

Rendered (`shared/src/grammar/transform.ts`):

```
Take [a piece]
Take emails from Gmail about “pasta” and [do what?]
Take emails from Gmail about “pasta” and summarize each one [in one line].
Take emails from Gmail about “pasta” and pull out “the recipe name” and “the cook time” from each one.
Take the recipe name, the cook time from emails from Gmail about “pasta” and keep only the ones where the cook time contains “min”.
```

### Result fields

`result.fields.mode` decides what a later piece sees when it reads from this one (`shared/src/grammar/fields.ts`):

| `mode` | Result has |
|---|---|
| `same` (default) | The source's fields |
| `none` | No fields (a single document, a PDF) |
| `replace` | Only `fields` |
| `extend` | The source's fields plus `fields` |

Modifiers, applied after the mode:

| Key | Effect |
|---|---|
| `fromParam` | Each entry of the named `texts` param becomes a `string` field: "pull out “the cook time”" yields a field `the_cook_time`. |
| `enumFromParam: { param, fieldId, label }` | The entries of a `texts` param become the values of one `enum` field: "sort each one into one of: recipe, restaurant" yields `category` with those two values. |
| `withRef` | The fields of the piece named by a `ref` param are appended: "combine with *contacts*" makes contact fields available. |
| `pickFromParam` | Only the fields chosen in a `fields` param survive: "keep only these fields: subject and sender". |

Duplicate field ids are collapsed; a field reached through two branches is not treated as a cycle.

## A complete example

A small ticketing system that can be read and written:

```json
{
  "id": "helpdesk",
  "name": "Helpdesk",
  "version": "1.0.0",
  "description": "Tickets and agents in the internal helpdesk.",
  "category": "IT & support",
  "icon": "🎫",
  "kind": "integration",
  "roles": ["input", "output"],
  "objects": [
    {
      "id": "tickets",
      "label": "tickets",
      "singular": "ticket",
      "description": "Requests raised by staff.",
      "timeField": "opened_at",
      "fields": [
        { "id": "number", "label": "ticket number", "type": "string" },
        { "id": "title", "label": "title", "type": "string" },
        { "id": "status", "label": "status", "type": "enum", "values": ["New", "In progress", "Waiting", "Resolved"] },
        { "id": "priority", "label": "priority", "type": "enum", "values": ["P1", "P2", "P3"] },
        { "id": "requester", "label": "requester", "type": "person" },
        { "id": "assignee", "label": "assignee", "type": "person" },
        { "id": "opened_at", "label": "opened", "type": "datetime" }
      ]
    },
    {
      "id": "agents",
      "label": "agents",
      "singular": "agent",
      "fields": [
        { "id": "name", "label": "name", "type": "string" },
        { "id": "email", "label": "email address", "type": "email" },
        { "id": "team", "label": "team", "type": "string" }
      ]
    }
  ],
  "actions": [
    {
      "id": "create_ticket",
      "label": "a ticket",
      "pattern": "create",
      "params": [
        { "id": "queue", "label": "in the queue", "type": "text", "placeholder": "queue name" },
        { "id": "priority", "label": "at priority", "type": "enum", "values": ["P1", "P2", "P3"], "optional": true },
        { "id": "title_from", "label": "titled after", "type": "field", "placeholder": "which field?", "optional": true }
      ]
    },
    {
      "id": "add_comment",
      "label": "a comment on each ticket",
      "verb": "Post",
      "params": [
        { "id": "visibility", "label": "visible to", "type": "enum", "values": ["agents only", "the requester too"] }
      ]
    }
  ],
  "guidance": "Reached through the Helpdesk REST API with an agent token. Never resolve tickets automatically; leave status changes to a person.",
  "setup": { "notes": "Ask the service desk lead for an API token scoped to the queues named in the plan." }
}
```

Sentences it produces:

```
I want to get tickets from Helpdesk where status is Waiting and opened is in the last 7 days, every weekday morning.
Create a ticket in Helpdesk from the summaries in the queue “Facilities” at priority P2.
Post the summaries to Helpdesk as a comment on each ticket visible to agents only.
```

## What administrators change

App administrators (Admin → Integrations) and the integration administrator recorded as a plugin's owner (Integrations) can, without touching the manifest:

- turn the plugin off (app admin only), which removes it from every menu;
- assign the owner (app admin only);
- replace `guidance` with the organization's own instruction, and `setup.notes` with the real access path;
- hide individual objects, actions, or operations.

These settings live in the database (`plugin_settings`) and survive upgrades. `shared/src/catalog.ts` merges them into the catalog the grammar reads, so hidden objects never appear in a sentence. The helper's system prompt (`server/src/helper/prompt.ts`) includes each enabled plugin's effective guidance and access notes, and every handoff prints them under "How this should be built" for the plugins the plan touches (`shared/src/handoff.ts`).

## Checklist

- `id` equals the directory name; every inner id is snake_case.
- Object labels are plural and lowercase; `singular` is set.
- Every `enum` has `values`; every `timeField` names a date field on the same object.
- Param labels read naturally before the blank; required params before optional ones.
- `result.label` uses `{source}` and names the result the way people would refer to it.
- `guidance` says how the system is actually reached and what to avoid; `setup.notes` says whom to ask.
- `npm run validate-plugins` passes.
