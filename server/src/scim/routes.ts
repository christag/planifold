/**
 * SCIM 2.0 (RFC 7643/7644) provisioning endpoints under /api/scim/v2, written
 * against Okta's SCIM client and usable by any SCIM 2.0 client. Users and
 * Groups are supported, with filtering by one `eq` clause, pagination, PUT
 * replacement, PATCH operations, and the discovery endpoints. Requests are
 * authenticated by a bearer token created in Admin → Sign-in; the session
 * cookie is never accepted here.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app.js";
import { deleteUserSessions } from "../auth/session.js";
import { createUser, deleteUser, findUserByEmail, findUserById, findUserByScimExternalId, updateUser, type UserPatch } from "../auth/users.js";
import type { Db } from "../db/index.js";
import { now } from "../db/index.js";
import { audit, uuid, type User } from "../db/models.js";
import { parseFilter, ScimFilterError } from "./filter.js";
import { authenticateScim, type ScimTokenRow } from "./tokens.js";

export const SCIM_BASE = "/api/scim/v2";
const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
const GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";
const LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";
const CONTENT_TYPE = "application/scim+json; charset=utf-8";
const MAX_PAGE = 500;

declare module "fastify" {
  interface FastifyRequest {
    scimToken: ScimTokenRow | null;
  }
}

export class ScimError extends Error {
  constructor(
    public status: number,
    message: string,
    public scimType?: string,
  ) {
    super(message);
  }
}

interface GroupRow {
  id: string;
  display_name: string;
  external_id: string | null;
  created_at: string;
  updated_at: string;
}

// Request bodies. Clients send attributes this server does not store (title,
// locale, the enterprise extension…); those are accepted and ignored.
const Name = z.looseObject({ givenName: z.string().max(120).nullish(), familyName: z.string().max(120).nullish(), formatted: z.string().max(240).nullish() });
const Email = z.looseObject({ value: z.string().max(320), primary: z.boolean().optional(), type: z.string().optional() });
const UserBody = z.looseObject({
  userName: z.string().min(1).max(320),
  externalId: z.string().max(200).nullish(),
  name: Name.nullish(),
  displayName: z.string().max(120).nullish(),
  emails: z.array(Email).nullish(),
  active: z.boolean().optional(),
});
const Member = z.looseObject({ value: z.string().min(1), display: z.string().optional() });
const GroupBody = z.looseObject({
  displayName: z.string().min(1).max(200),
  externalId: z.string().max(200).nullish(),
  members: z.array(Member).nullish(),
});
const PatchBody = z.looseObject({
  Operations: z.array(z.looseObject({ op: z.string(), path: z.string().max(500).optional(), value: z.unknown().optional() })).min(1),
});
const ListQuery = z.object({
  filter: z.string().max(1000).optional(),
  startIndex: z.coerce.number().int().optional(),
  count: z.coerce.number().int().optional(),
  excludedAttributes: z.string().optional(),
});

export async function scimRoutes(app: FastifyInstance, opts: { ctx: AppContext }) {
  const { db, config } = opts.ctx;

  app.addContentTypeParser(["application/scim+json"], { parseAs: "string" }, (_req, body, done) => {
    try {
      done(null, body.length ? JSON.parse(body as string) : {});
    } catch {
      done(new ScimError(400, "The request body is not valid JSON.", "invalidSyntax"), undefined);
    }
  });

  app.decorateRequest("scimToken", null);

  // Bearer token or nothing. Runs before every SCIM route, including the 404.
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    req.scimToken = authenticateScim(db, req.headers.authorization);
    if (!req.scimToken) {
      reply.header("WWW-Authenticate", 'Bearer realm="scim"');
      throw new ScimError(401, "A valid bearer token is required.");
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ScimError) return sendError(reply, err.status, err.message, err.scimType);
    if (err instanceof ScimFilterError) return sendError(reply, 400, err.message, "invalidFilter");
    if (err instanceof z.ZodError) return sendError(reply, 400, `Some of that didn't look right: ${err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}`, "invalidValue");
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) req.log.error({ err }, "scim request failed");
    return sendError(reply, status, status >= 500 ? "Something went wrong on the server." : (err as Error).message);
  });

  const baseOf = (req: FastifyRequest) => `${config.baseUrl ?? `${req.protocol}://${req.headers.host}`}${SCIM_BASE}`;
  const actor = (req: FastifyRequest) => ({ id: req.scimToken!.id, email: `scim:${req.scimToken!.label}` });
  const page = (q: z.infer<typeof ListQuery>) => {
    const startIndex = Math.max(1, q.startIndex ?? 1);
    const count = Math.min(MAX_PAGE, Math.max(0, q.count ?? 100));
    return { startIndex, count, offset: startIndex - 1 };
  };
  const list = (reply: FastifyReply, p: { startIndex: number; count: number }, total: number, resources: unknown[]) =>
    send(reply, 200, { schemas: [LIST_SCHEMA], totalResults: total, startIndex: p.startIndex, itemsPerPage: resources.length, Resources: resources });

  // Discovery

  app.get(`${SCIM_BASE}/ServiceProviderConfig`, async (req, reply) =>
    send(reply, 200, {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
      documentationUri: "https://github.com/christag/planifold/blob/main/docs/deploy.md",
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: MAX_PAGE },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [{ type: "oauthbearertoken", name: "OAuth Bearer Token", description: "Authentication scheme using the OAuth Bearer Token Standard", primary: true }],
      meta: { resourceType: "ServiceProviderConfig", location: `${baseOf(req)}/ServiceProviderConfig` },
    }),
  );

  app.get(`${SCIM_BASE}/ResourceTypes`, async (req, reply) => {
    const base = baseOf(req);
    const types = [
      { schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"], id: "User", name: "User", endpoint: "/Users", description: "User account", schema: USER_SCHEMA, meta: { resourceType: "ResourceType", location: `${base}/ResourceTypes/User` } },
      { schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"], id: "Group", name: "Group", endpoint: "/Groups", description: "Group", schema: GROUP_SCHEMA, meta: { resourceType: "ResourceType", location: `${base}/ResourceTypes/Group` } },
    ];
    return list(reply, { startIndex: 1, count: types.length }, types.length, types);
  });

  app.get(`${SCIM_BASE}/Schemas`, async (req, reply) => {
    const base = baseOf(req);
    const attr = (name: string, extra: Record<string, unknown> = {}) => ({ name, type: "string", multiValued: false, required: false, caseExact: false, mutability: "readWrite", returned: "default", uniqueness: "none", ...extra });
    const schemas = [
      {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:Schema"],
        id: USER_SCHEMA,
        name: "User",
        description: "User account",
        attributes: [
          attr("userName", { required: true, uniqueness: "server", description: "The person's email address." }),
          attr("externalId", { caseExact: true }),
          attr("displayName"),
          attr("name", { type: "complex", subAttributes: [attr("givenName"), attr("familyName"), attr("formatted")] }),
          attr("emails", { type: "complex", multiValued: true, subAttributes: [attr("value"), attr("type"), attr("primary", { type: "boolean" })] }),
          attr("active", { type: "boolean" }),
          attr("groups", { type: "complex", multiValued: true, mutability: "readOnly", subAttributes: [attr("value", { mutability: "readOnly" }), attr("display", { mutability: "readOnly" })] }),
        ],
        meta: { resourceType: "Schema", location: `${base}/Schemas/${USER_SCHEMA}` },
      },
      {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:Schema"],
        id: GROUP_SCHEMA,
        name: "Group",
        description: "Group",
        attributes: [
          attr("displayName", { required: true, uniqueness: "server" }),
          attr("externalId", { caseExact: true }),
          attr("members", { type: "complex", multiValued: true, subAttributes: [attr("value", { mutability: "immutable" }), attr("display", { mutability: "readOnly" })] }),
        ],
        meta: { resourceType: "Schema", location: `${base}/Schemas/${GROUP_SCHEMA}` },
      },
    ];
    return list(reply, { startIndex: 1, count: schemas.length }, schemas.length, schemas);
  });

  // Users

  app.get(`${SCIM_BASE}/Users`, async (req, reply) => {
    const q = ListQuery.parse(req.query);
    const p = page(q);
    const filter = parseFilter(q.filter);
    let where = "";
    const args: unknown[] = [];
    if (filter) {
      const a = filter.attribute.toLowerCase();
      if (a === "username" || a === "emails.value" || a === "emails") (where = "WHERE email = ?"), args.push(filter.value.trim().toLowerCase());
      else if (a === "externalid") (where = "WHERE scim_external_id = ?"), args.push(filter.value);
      else if (a === "id") (where = "WHERE id = ?"), args.push(filter.value);
      else throw new ScimError(400, `Filtering users by "${filter.attribute}" is not supported. Use userName, emails.value, externalId, or id.`, "invalidFilter");
    }
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM users ${where}`).get(...args) as { n: number }).n;
    const rows = db.prepare(`SELECT * FROM users ${where} ORDER BY created_at, id LIMIT ? OFFSET ?`).all(...args, p.count, p.offset) as User[];
    const base = baseOf(req);
    return list(reply, p, total, rows.map((u) => scimUser(db, u, base)));
  });

  app.get(`${SCIM_BASE}/Users/:id`, async (req, reply) => {
    const u = findUserById(db, (req.params as { id: string }).id);
    if (!u) throw new ScimError(404, "No user has that id.");
    return send(reply, 200, scimUser(db, u, baseOf(req)));
  });

  app.post(`${SCIM_BASE}/Users`, async (req, reply) => {
    const body = UserBody.parse(req.body ?? {});
    const f = userFields(body);
    if (findUserByEmail(db, f.email)) throw new ScimError(409, `A user with the userName ${f.email} already exists.`, "uniqueness");
    if (f.externalId && findUserByScimExternalId(db, f.externalId)) throw new ScimError(409, `A user with the externalId ${f.externalId} already exists.`, "uniqueness");
    const p = config.auth.provisioning;
    const role = p.adminEmails.includes(f.email) ? "app_admin" : p.defaultRole;
    let user = createUser(db, { email: f.email, name: f.name, role, authSource: "scim", scimExternalId: f.externalId, givenName: f.givenName, familyName: f.familyName });
    if (!f.active) user = updateUser(db, user.id, { disabled: true });
    audit(db, actor(req), "user.created", user.id, { via: "scim", email: user.email, role, active: f.active });
    reply.header("Location", `${baseOf(req)}/Users/${user.id}`);
    return send(reply, 201, scimUser(db, user, baseOf(req)));
  });

  app.put(`${SCIM_BASE}/Users/:id`, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const existing = findUserById(db, id);
    if (!existing) throw new ScimError(404, "No user has that id.");
    const body = UserBody.parse(req.body ?? {});
    const f = userFields(body);
    const user = applyUserChange(db, existing, { email: f.email, name: f.name, givenName: f.givenName, familyName: f.familyName, externalId: f.externalId, active: f.active });
    audit(db, actor(req), "user.updated", user.id, { via: "scim", method: "PUT", email: user.email, active: !user.disabled });
    return send(reply, 200, scimUser(db, user, baseOf(req)));
  });

  app.patch(`${SCIM_BASE}/Users/:id`, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const existing = findUserById(db, id);
    if (!existing) throw new ScimError(404, "No user has that id.");
    const body = PatchBody.parse(req.body ?? {});
    const change: UserChange = {};
    for (const op of body.Operations) {
      const kind = op.op.toLowerCase();
      if (!["add", "replace", "remove"].includes(kind)) throw new ScimError(400, `Unknown patch operation "${op.op}".`, "invalidValue");
      if (op.path) {
        applyUserPath(change, op.path, kind === "remove" ? null : op.value);
      } else {
        if (kind === "remove") throw new ScimError(400, "A remove operation needs a path.", "noTarget");
        if (!op.value || typeof op.value !== "object" || Array.isArray(op.value)) throw new ScimError(400, "A patch operation without a path needs an object value.", "invalidValue");
        for (const [k, v] of Object.entries(op.value as Record<string, unknown>)) applyUserPath(change, k, v);
      }
    }
    const user = applyUserChange(db, existing, change);
    audit(db, actor(req), "user.updated", user.id, { via: "scim", method: "PATCH", changed: Object.keys(change), active: !user.disabled });
    return send(reply, 200, scimUser(db, user, baseOf(req)));
  });

  app.delete(`${SCIM_BASE}/Users/:id`, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const existing = findUserById(db, id);
    if (!existing) throw new ScimError(404, "No user has that id.");
    deleteUser(db, id);
    audit(db, actor(req), "user.deleted", id, { via: "scim", email: existing.email });
    return reply.code(204).send();
  });

  // Groups

  app.get(`${SCIM_BASE}/Groups`, async (req, reply) => {
    const q = ListQuery.parse(req.query);
    const p = page(q);
    const filter = parseFilter(q.filter);
    let where = "";
    const args: unknown[] = [];
    if (filter) {
      const a = filter.attribute.toLowerCase();
      if (a === "displayname") (where = "WHERE display_name = ? COLLATE NOCASE"), args.push(filter.value);
      else if (a === "externalid") (where = "WHERE external_id = ?"), args.push(filter.value);
      else if (a === "id") (where = "WHERE id = ?"), args.push(filter.value);
      else throw new ScimError(400, `Filtering groups by "${filter.attribute}" is not supported. Use displayName, externalId, or id.`, "invalidFilter");
    }
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM scim_groups ${where}`).get(...args) as { n: number }).n;
    const rows = db.prepare(`SELECT * FROM scim_groups ${where} ORDER BY created_at, id LIMIT ? OFFSET ?`).all(...args, p.count, p.offset) as GroupRow[];
    const withMembers = !excludes(q.excludedAttributes, "members");
    const base = baseOf(req);
    return list(reply, p, total, rows.map((g) => scimGroup(db, g, base, withMembers)));
  });

  app.get(`${SCIM_BASE}/Groups/:id`, async (req, reply) => {
    const g = findGroup(db, (req.params as { id: string }).id);
    if (!g) throw new ScimError(404, "No group has that id.");
    const q = ListQuery.parse(req.query);
    return send(reply, 200, scimGroup(db, g, baseOf(req), !excludes(q.excludedAttributes, "members")));
  });

  app.post(`${SCIM_BASE}/Groups`, async (req, reply) => {
    const body = GroupBody.parse(req.body ?? {});
    if (findGroupByName(db, body.displayName)) throw new ScimError(409, `A group named ${body.displayName} already exists.`, "uniqueness");
    if (body.externalId && findGroupByExternalId(db, body.externalId)) throw new ScimError(409, `A group with the externalId ${body.externalId} already exists.`, "uniqueness");
    const members = memberIds(db, body.members ?? []);
    const id = uuid();
    const t = now();
    db.transaction(() => {
      db.prepare("INSERT INTO scim_groups (id, display_name, external_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(id, body.displayName.trim(), body.externalId ?? null, t, t);
      setMembers(db, id, members);
    })();
    const g = findGroup(db, id)!;
    audit(db, actor(req), "group.created", id, { via: "scim", displayName: g.display_name, members: members.length });
    reply.header("Location", `${baseOf(req)}/Groups/${id}`);
    return send(reply, 201, scimGroup(db, g, baseOf(req), true));
  });

  app.put(`${SCIM_BASE}/Groups/:id`, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const existing = findGroup(db, id);
    if (!existing) throw new ScimError(404, "No group has that id.");
    const body = GroupBody.parse(req.body ?? {});
    const clash = findGroupByName(db, body.displayName);
    if (clash && clash.id !== id) throw new ScimError(409, `A group named ${body.displayName} already exists.`, "uniqueness");
    const members = memberIds(db, body.members ?? []);
    db.transaction(() => {
      db.prepare("UPDATE scim_groups SET display_name = ?, external_id = ?, updated_at = ? WHERE id = ?").run(body.displayName.trim(), body.externalId ?? existing.external_id, now(), id);
      setMembers(db, id, members);
    })();
    const g = findGroup(db, id)!;
    audit(db, actor(req), "group.updated", id, { via: "scim", method: "PUT", displayName: g.display_name, members: members.length });
    return send(reply, 200, scimGroup(db, g, baseOf(req), true));
  });

  app.patch(`${SCIM_BASE}/Groups/:id`, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const existing = findGroup(db, id);
    if (!existing) throw new ScimError(404, "No group has that id.");
    const body = PatchBody.parse(req.body ?? {});
    let displayName = existing.display_name;
    let externalId = existing.external_id;
    let members = new Set(currentMemberIds(db, id));
    const applyMembers = (kind: string, value: unknown, filterId?: string) => {
      if (kind === "remove") {
        if (filterId) members.delete(filterId);
        else if (Array.isArray(value)) for (const m of memberIds(db, Member.array().parse(value), false)) members.delete(m);
        else members = new Set();
        return;
      }
      const ids = memberIds(db, Member.array().parse(Array.isArray(value) ? value : [value]));
      if (kind === "replace") members = new Set(ids);
      else for (const m of ids) members.add(m);
    };
    for (const op of body.Operations) {
      const kind = op.op.toLowerCase();
      if (!["add", "replace", "remove"].includes(kind)) throw new ScimError(400, `Unknown patch operation "${op.op}".`, "invalidValue");
      const path = op.path?.trim();
      if (!path) {
        if (kind === "remove") throw new ScimError(400, "A remove operation needs a path.", "noTarget");
        if (!op.value || typeof op.value !== "object" || Array.isArray(op.value)) throw new ScimError(400, "A patch operation without a path needs an object value.", "invalidValue");
        const v = op.value as Record<string, unknown>;
        if (typeof v.displayName === "string") displayName = v.displayName;
        if (v.externalId === null || typeof v.externalId === "string") externalId = v.externalId;
        if (v.members !== undefined) applyMembers(kind, v.members);
        continue;
      }
      const memberFilter = /^members\[\s*value\s+eq\s+"((?:[^"\\]|\\.)*)"\s*\]$/i.exec(path);
      if (memberFilter) applyMembers(kind, op.value, memberFilter[1]!.replace(/\\(.)/g, "$1"));
      else if (/^members$/i.test(path)) applyMembers(kind, op.value);
      else if (/^displayName$/i.test(path)) {
        if (kind === "remove" || typeof op.value !== "string") throw new ScimError(400, "displayName needs a string value.", "invalidValue");
        displayName = op.value;
      } else if (/^externalId$/i.test(path)) externalId = kind === "remove" ? null : typeof op.value === "string" ? op.value : externalId;
      else throw new ScimError(400, `The path "${op.path}" is not supported on a group.`, "invalidPath");
    }
    displayName = displayName.trim();
    if (!displayName) throw new ScimError(400, "displayName can't be empty.", "invalidValue");
    const clash = findGroupByName(db, displayName);
    if (clash && clash.id !== id) throw new ScimError(409, `A group named ${displayName} already exists.`, "uniqueness");
    const ids = [...members];
    db.transaction(() => {
      db.prepare("UPDATE scim_groups SET display_name = ?, external_id = ?, updated_at = ? WHERE id = ?").run(displayName, externalId, now(), id);
      setMembers(db, id, ids);
    })();
    const g = findGroup(db, id)!;
    audit(db, actor(req), "group.updated", id, { via: "scim", method: "PATCH", displayName: g.display_name, members: ids.length });
    return send(reply, 200, scimGroup(db, g, baseOf(req), true));
  });

  app.delete(`${SCIM_BASE}/Groups/:id`, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const existing = findGroup(db, id);
    if (!existing) throw new ScimError(404, "No group has that id.");
    db.prepare("DELETE FROM scim_groups WHERE id = ?").run(id);
    audit(db, actor(req), "group.deleted", id, { via: "scim", displayName: existing.display_name });
    return reply.code(204).send();
  });

  app.all(`${SCIM_BASE}/*`, async () => {
    throw new ScimError(404, "No such SCIM endpoint.");
  });
  app.all(SCIM_BASE, async () => {
    throw new ScimError(404, "No such SCIM endpoint.");
  });
}

// Users: reading a request body into what this server stores

interface UserFields {
  email: string;
  name: string;
  givenName: string | null;
  familyName: string | null;
  externalId: string | null;
  active: boolean;
}

/** What a PATCH may change. `undefined` means "leave as is". */
interface UserChange {
  email?: string;
  name?: string;
  givenName?: string | null;
  familyName?: string | null;
  externalId?: string | null;
  active?: boolean;
}

const isEmail = (v: unknown): v is string => typeof v === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());

function primaryEmail(emails: Array<{ value: string; primary?: boolean }> | null | undefined): string | undefined {
  if (!emails?.length) return undefined;
  const e = emails.find((x) => x.primary) ?? emails[0]!;
  return isEmail(e.value) ? e.value.trim().toLowerCase() : undefined;
}

function userFields(body: z.infer<typeof UserBody>): UserFields {
  const email = isEmail(body.userName) ? body.userName.trim().toLowerCase() : primaryEmail(body.emails);
  if (!email) throw new ScimError(400, "userName must be an email address (or emails must carry one); Planifold identifies people by email.", "invalidValue");
  const givenName = body.name?.givenName?.trim() || null;
  const familyName = body.name?.familyName?.trim() || null;
  const name = body.displayName?.trim() || body.name?.formatted?.trim() || [givenName, familyName].filter(Boolean).join(" ") || email.split("@")[0]!;
  return { email, name, givenName, familyName, externalId: body.externalId?.trim() || null, active: body.active ?? true };
}

function asBoolean(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return ["true", "1", "yes"].includes(v.trim().toLowerCase());
  throw new ScimError(400, "active must be true or false.", "invalidValue");
}

/** Applies one `path: value` pair from a PATCH to the pending change. Attributes this server does not store are ignored. */
function applyUserPath(change: UserChange, rawPath: string, value: unknown): void {
  const path = rawPath.trim().replace(/^urn:ietf:params:scim:schemas:core:2\.0:User:/i, "");
  const lower = path.toLowerCase();
  if (lower === "active") change.active = value === null ? false : asBoolean(value);
  else if (lower === "username") {
    if (!isEmail(value)) throw new ScimError(400, "userName must be an email address.", "invalidValue");
    change.email = value.trim().toLowerCase();
  } else if (lower === "externalid") change.externalId = value === null ? null : String(value);
  else if (lower === "displayname") change.name = value === null ? "" : String(value);
  else if (lower === "name.givenname") change.givenName = value === null ? null : String(value);
  else if (lower === "name.familyname") change.familyName = value === null ? null : String(value);
  else if (lower === "name.formatted") change.name ??= value === null ? "" : String(value);
  else if (lower === "name" && value && typeof value === "object") {
    const n = value as Record<string, unknown>;
    if ("givenName" in n) change.givenName = n.givenName === null ? null : String(n.givenName);
    if ("familyName" in n) change.familyName = n.familyName === null ? null : String(n.familyName);
    if (typeof n.formatted === "string") change.name ??= n.formatted;
  } else if (lower === "emails" && Array.isArray(value)) {
    const e = primaryEmail(value as Array<{ value: string; primary?: boolean }>);
    if (e) change.email = e;
  } else if (/^emails\[.*\]\.value$/i.test(path)) {
    if (isEmail(value)) change.email = value.trim().toLowerCase();
  }
  // Anything else (title, locale, phone numbers, the enterprise extension…) is not stored.
}

function applyUserChange(db: Db, existing: User, change: UserChange): User {
  const patch: UserPatch = {};
  if (change.email !== undefined && change.email !== existing.email) {
    const clash = findUserByEmail(db, change.email);
    if (clash && clash.id !== existing.id) throw new ScimError(409, `A user with the userName ${change.email} already exists.`, "uniqueness");
    patch.email = change.email;
  }
  if (change.externalId !== undefined && change.externalId !== existing.scim_external_id) {
    if (change.externalId) {
      const clash = findUserByScimExternalId(db, change.externalId);
      if (clash && clash.id !== existing.id) throw new ScimError(409, `A user with the externalId ${change.externalId} already exists.`, "uniqueness");
    }
    patch.scimExternalId = change.externalId;
  }
  if (change.givenName !== undefined) patch.givenName = change.givenName;
  if (change.familyName !== undefined) patch.familyName = change.familyName;
  const given = change.givenName === undefined ? existing.given_name : change.givenName;
  const family = change.familyName === undefined ? existing.family_name : change.familyName;
  if (change.name !== undefined) {
    // An explicit display name wins; without one, a changed given/family name rebuilds it.
    const name = change.name.trim() || [given, family].filter(Boolean).join(" ").trim() || (patch.email ?? existing.email).split("@")[0]!;
    if (name !== existing.name) patch.name = name;
  } else if ((change.givenName !== undefined || change.familyName !== undefined) && (given || family)) {
    const rebuilt = [given, family].filter(Boolean).join(" ").trim();
    if (rebuilt && rebuilt !== existing.name) patch.name = rebuilt;
  }
  if (change.active !== undefined && change.active === !!existing.disabled) patch.disabled = !change.active;
  const user = Object.keys(patch).length ? updateUser(db, existing.id, patch) : existing;
  if (patch.disabled) deleteUserSessions(db, existing.id);
  return user;
}

// Serialization

function groupsOfUser(db: Db, userId: string): Array<{ id: string; display_name: string }> {
  return db.prepare("SELECT g.id, g.display_name FROM scim_group_members m JOIN scim_groups g ON g.id = m.group_id WHERE m.user_id = ? ORDER BY g.display_name").all(userId) as Array<{ id: string; display_name: string }>;
}

function scimUser(db: Db, u: User, base: string) {
  return {
    schemas: [USER_SCHEMA],
    id: u.id,
    externalId: u.scim_external_id ?? undefined,
    userName: u.email,
    name: { givenName: u.given_name ?? undefined, familyName: u.family_name ?? undefined, formatted: u.name },
    displayName: u.name,
    emails: [{ value: u.email, type: "work", primary: true }],
    active: !u.disabled,
    groups: groupsOfUser(db, u.id).map((g) => ({ value: g.id, display: g.display_name, $ref: `${base}/Groups/${g.id}` })),
    meta: { resourceType: "User", created: u.created_at, lastModified: u.updated_at ?? u.created_at, location: `${base}/Users/${u.id}` },
  };
}

function scimGroup(db: Db, g: GroupRow, base: string, withMembers: boolean) {
  const members = withMembers
    ? (db.prepare("SELECT u.id, u.name FROM scim_group_members m JOIN users u ON u.id = m.user_id WHERE m.group_id = ? ORDER BY u.name").all(g.id) as Array<{ id: string; name: string }>).map((u) => ({ value: u.id, display: u.name, $ref: `${base}/Users/${u.id}` }))
    : undefined;
  return {
    schemas: [GROUP_SCHEMA],
    id: g.id,
    externalId: g.external_id ?? undefined,
    displayName: g.display_name,
    members,
    meta: { resourceType: "Group", created: g.created_at, lastModified: g.updated_at, location: `${base}/Groups/${g.id}` },
  };
}

// Groups: storage helpers

function findGroup(db: Db, id: string): GroupRow | undefined {
  return db.prepare("SELECT * FROM scim_groups WHERE id = ?").get(id) as GroupRow | undefined;
}
function findGroupByName(db: Db, name: string): GroupRow | undefined {
  return db.prepare("SELECT * FROM scim_groups WHERE display_name = ? COLLATE NOCASE").get(name.trim()) as GroupRow | undefined;
}
function findGroupByExternalId(db: Db, externalId: string): GroupRow | undefined {
  return db.prepare("SELECT * FROM scim_groups WHERE external_id = ?").get(externalId) as GroupRow | undefined;
}
function currentMemberIds(db: Db, groupId: string): string[] {
  return (db.prepare("SELECT user_id FROM scim_group_members WHERE group_id = ?").all(groupId) as Array<{ user_id: string }>).map((r) => r.user_id);
}
function setMembers(db: Db, groupId: string, userIds: string[]): void {
  db.prepare("DELETE FROM scim_group_members WHERE group_id = ?").run(groupId);
  const insert = db.prepare("INSERT OR IGNORE INTO scim_group_members (group_id, user_id) VALUES (?, ?)");
  for (const id of userIds) insert.run(groupId, id);
}
/** Member references must name users this server knows; a wrong id is an error the client should see, not a silently smaller group. */
function memberIds(db: Db, members: Array<{ value: string }>, strict = true): string[] {
  const ids: string[] = [];
  for (const m of members) {
    const id = m.value.trim();
    if (findUserById(db, id)) ids.push(id);
    else if (strict) throw new ScimError(400, `No user has the id ${id}, so it can't be a group member.`, "invalidValue");
  }
  return [...new Set(ids)];
}

// Responses

function excludes(excludedAttributes: string | undefined, attribute: string): boolean {
  return (excludedAttributes ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .includes(attribute.toLowerCase());
}

function send(reply: FastifyReply, status: number, body: unknown) {
  return reply.code(status).type(CONTENT_TYPE).send(JSON.stringify(body));
}

function sendError(reply: FastifyReply, status: number, detail: string, scimType?: string) {
  return send(reply, status, { schemas: [ERROR_SCHEMA], status: String(status), ...(scimType ? { scimType } : {}), detail });
}
