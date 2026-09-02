import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app.js";
import { requireRole } from "../auth/plugin.js";
import { deleteUserSessions } from "../auth/session.js";
import { createUser, deleteUser, findUserByEmail, findUserById, listUsers, temporaryPassword, updateUser } from "../auth/users.js";
import { maskSecret } from "../crypto.js";
import { now, parseJson } from "../db/index.js";
import { audit, publicUser, uuid, type ProviderRow } from "../db/models.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { listPlans } from "../plans/repo.js";

const Role = z.enum(["user", "integration_admin", "app_admin"]);
const UserCreate = z.object({ email: z.string().email(), name: z.string().min(1).max(120), role: Role.default("user"), password: z.string().min(10).max(200).optional() });
const UserPatch = z.object({ name: z.string().min(1).max(120).optional(), role: Role.optional(), disabled: z.boolean().optional(), resetPassword: z.boolean().optional() });
const ProviderKind = z.enum(["anthropic", "openai", "openai_compatible"]);
const ProviderCreate = z.object({
  kind: ProviderKind,
  label: z.string().min(1).max(80),
  model: z.string().min(1).max(120),
  apiKey: z.string().max(4000).optional(),
  baseUrl: z.string().url().max(500).optional().nullable(),
});
const ProviderPatch = ProviderCreate.partial();
const SettingsPatch = z.object({
  orgName: z.string().max(120).optional(),
  orgGuidance: z.string().max(8000).optional(),
  preferredBuilder: z.string().max(200).optional(),
});
const PluginPatch = z.object({
  enabled: z.boolean().optional(),
  ownerId: z.string().nullable().optional(),
  guidance: z.string().max(8000).nullable().optional(),
  setupNotes: z.string().max(4000).nullable().optional(),
  overrides: z
    .object({
      disabledObjects: z.array(z.string()).optional(),
      disabledActions: z.array(z.string()).optional(),
      disabledOperations: z.array(z.string()).optional(),
    })
    .optional(),
});

export function publicProvider(p: ProviderRow, box: { open(s: string): string }) {
  let keyHint: string | null = null;
  if (p.api_key_enc) {
    try {
      keyHint = maskSecret(box.open(p.api_key_enc));
    } catch {
      keyHint = "•••• (unreadable: APP_SECRET changed)";
    }
  }
  return {
    id: p.id,
    kind: p.kind,
    label: p.label,
    model: p.model,
    baseUrl: p.base_url,
    hasKey: !!p.api_key_enc,
    keyHint,
    isActive: !!p.is_active,
    lastTestAt: p.last_test_at,
    lastTestOk: p.last_test_ok === null ? null : !!p.last_test_ok,
    lastTestMessage: p.last_test_message,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  };
}

export async function adminRoutes(app: FastifyInstance, opts: { ctx: AppContext }) {
  const { db, registry, box, settings, helper } = opts.ctx;

  // This plugin is encapsulated, so the hook covers exactly the admin routes,
  // whatever the request url looks like on the wire.
  app.addHook("onRequest", async (req) => {
    requireRole(req, "app_admin");
  });

  app.get("/api/admin/overview", async () => {
    const users = listUsers(db);
    const catalog = registry.catalog();
    return {
      users: users.length,
      admins: users.filter((u) => u.role === "app_admin").length,
      plans: listPlans(db, null).length,
      pluginsLoaded: registry.plugins.size,
      integrationsEnabled: catalog.integrations.length,
      operationsEnabled: catalog.operations.length,
      pluginProblems: registry.problems,
      helper: helper.status(),
      settings: {
        orgName: settings.get<string>("orgName", ""),
        orgGuidance: settings.get<string>("orgGuidance", ""),
        preferredBuilder: settings.get<string>("preferredBuilder", ""),
      },
    };
  });

  // Users
  app.get("/api/admin/users", async () => ({ users: listUsers(db).map(publicUser) }));

  app.post("/api/admin/users", async (req) => {
    const actor = requireRole(req, "app_admin");
    const body = UserCreate.parse(req.body);
    if (findUserByEmail(db, body.email)) throw conflict("Someone already has that email.");
    const password = body.password ?? temporaryPassword();
    const user = createUser(db, { email: body.email, name: body.name, role: body.role, password, mustChangePassword: true });
    audit(db, { id: actor.id, email: actor.email }, "user.created", user.id, { email: user.email, role: user.role });
    return { user: publicUser(user), temporaryPassword: password };
  });

  app.patch("/api/admin/users/:id", async (req) => {
    const actor = requireRole(req, "app_admin");
    const id = (req.params as { id: string }).id;
    const target = findUserById(db, id);
    if (!target) throw notFound("That user doesn't exist.");
    const body = UserPatch.parse(req.body);
    if (id === actor.id && (body.role && body.role !== "app_admin")) throw badRequest("You can't remove your own administrator role.");
    if (id === actor.id && body.disabled) throw badRequest("You can't disable your own account.");
    let temporary: string | undefined;
    if (body.resetPassword) {
      if (target.auth_source !== "local") throw badRequest("This account signs in through the identity provider; there is no password to reset.");
      temporary = temporaryPassword();
    }
    const user = updateUser(db, id, { name: body.name, role: body.role, disabled: body.disabled, ...(temporary ? { password: temporary, mustChangePassword: true } : {}) });
    if (body.disabled || temporary) deleteUserSessions(db, id);
    audit(db, { id: actor.id, email: actor.email }, "user.updated", id, { ...body, resetPassword: !!temporary });
    return { user: publicUser(user), temporaryPassword: temporary };
  });

  app.delete("/api/admin/users/:id", async (req) => {
    const actor = requireRole(req, "app_admin");
    const id = (req.params as { id: string }).id;
    if (id === actor.id) throw badRequest("You can't delete your own account.");
    const target = findUserById(db, id);
    if (!target) throw notFound("That user doesn't exist.");
    deleteUser(db, id);
    audit(db, { id: actor.id, email: actor.email }, "user.deleted", id, { email: target.email });
    return { ok: true };
  });

  // AI providers
  app.get("/api/admin/providers", async () => ({ providers: helper.listProviders().map((p) => publicProvider(p, box)) }));

  app.post("/api/admin/providers", async (req) => {
    const actor = requireRole(req, "app_admin");
    const body = ProviderCreate.parse(req.body);
    if (body.kind !== "openai_compatible" && !body.apiKey) throw badRequest("An API key is required.");
    const id = uuid();
    const t = now();
    const first = helper.listProviders().length === 0;
    db.prepare("INSERT INTO llm_providers (id, kind, label, model, api_key_enc, base_url, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      id,
      body.kind,
      body.label,
      body.model,
      body.apiKey ? box.seal(body.apiKey) : null,
      body.baseUrl ?? null,
      first ? 1 : 0,
      t,
      t,
    );
    audit(db, { id: actor.id, email: actor.email }, "provider.created", id, { kind: body.kind, model: body.model, label: body.label });
    return { provider: publicProvider(helper.getProvider(id)!, box) };
  });

  app.patch("/api/admin/providers/:id", async (req) => {
    const actor = requireRole(req, "app_admin");
    const id = (req.params as { id: string }).id;
    if (!helper.getProvider(id)) throw notFound("That provider doesn't exist.");
    const body = ProviderPatch.parse(req.body);
    const sets: string[] = ["updated_at = ?"];
    const args: unknown[] = [now()];
    if (body.kind) (sets.push("kind = ?"), args.push(body.kind));
    if (body.label) (sets.push("label = ?"), args.push(body.label));
    if (body.model) (sets.push("model = ?"), args.push(body.model));
    if (body.apiKey) (sets.push("api_key_enc = ?"), args.push(box.seal(body.apiKey)));
    if (body.baseUrl !== undefined) (sets.push("base_url = ?"), args.push(body.baseUrl));
    db.prepare(`UPDATE llm_providers SET ${sets.join(", ")} WHERE id = ?`).run(...args, id);
    audit(db, { id: actor.id, email: actor.email }, "provider.updated", id, { ...body, apiKey: body.apiKey ? "(changed)" : undefined });
    return { provider: publicProvider(helper.getProvider(id)!, box) };
  });

  app.post("/api/admin/providers/:id/activate", async (req) => {
    const actor = requireRole(req, "app_admin");
    const id = (req.params as { id: string }).id;
    if (!helper.getProvider(id)) throw notFound("That provider doesn't exist.");
    db.transaction(() => {
      db.prepare("UPDATE llm_providers SET is_active = 0").run();
      db.prepare("UPDATE llm_providers SET is_active = 1, updated_at = ? WHERE id = ?").run(now(), id);
    })();
    audit(db, { id: actor.id, email: actor.email }, "provider.activated", id);
    return { providers: helper.listProviders().map((p) => publicProvider(p, box)) };
  });

  app.post("/api/admin/providers/:id/test", async (req) => {
    const id = (req.params as { id: string }).id;
    const row = helper.getProvider(id);
    if (!row) throw notFound("That provider doesn't exist.");
    const result = await helper.testProvider(row);
    db.prepare("UPDATE llm_providers SET last_test_at = ?, last_test_ok = ?, last_test_message = ? WHERE id = ?").run(now(), result.ok ? 1 : 0, result.message, id);
    return { ...result, provider: publicProvider(helper.getProvider(id)!, box) };
  });

  app.delete("/api/admin/providers/:id", async (req) => {
    const actor = requireRole(req, "app_admin");
    const id = (req.params as { id: string }).id;
    if (!helper.getProvider(id)) throw notFound("That provider doesn't exist.");
    db.prepare("DELETE FROM llm_providers WHERE id = ?").run(id);
    audit(db, { id: actor.id, email: actor.email }, "provider.deleted", id);
    return { ok: true };
  });

  // Settings
  app.patch("/api/admin/settings", async (req) => {
    const actor = requireRole(req, "app_admin");
    const body = SettingsPatch.parse(req.body);
    for (const [k, v] of Object.entries(body)) if (v !== undefined) settings.set(k, v.trim());
    audit(db, { id: actor.id, email: actor.email }, "settings.updated", null, Object.keys(body));
    return {
      settings: {
        orgName: settings.get<string>("orgName", ""),
        orgGuidance: settings.get<string>("orgGuidance", ""),
        preferredBuilder: settings.get<string>("preferredBuilder", ""),
      },
    };
  });

  // Plugins
  app.get("/api/admin/plugins", async () => ({ plugins: describePlugins(opts.ctx), problems: registry.problems }));

  app.patch("/api/admin/plugins/:id", async (req) => {
    const actor = requireRole(req, "app_admin");
    const id = (req.params as { id: string }).id;
    if (!registry.plugins.has(id)) throw notFound("That plugin isn't loaded.");
    const body = PluginPatch.parse(req.body);
    if (body.ownerId && !findUserById(db, body.ownerId)) throw badRequest("That owner doesn't exist.");
    registry.updateSettings(id, body);
    audit(db, { id: actor.id, email: actor.email }, "plugin.updated", id, body);
    return { plugin: describePlugins(opts.ctx).find((p) => p.id === id) };
  });

  app.post("/api/admin/plugins/reload", async (req) => {
    const actor = requireRole(req, "app_admin");
    registry.load();
    audit(db, { id: actor.id, email: actor.email }, "plugins.reloaded", null, { loaded: registry.plugins.size, problems: registry.problems.length });
    return { plugins: describePlugins(opts.ctx), problems: registry.problems };
  });

  // Audit log
  app.get("/api/admin/audit", async (req) => {
    const q = req.query as { limit?: string };
    const limit = Math.min(500, Math.max(1, Number(q.limit) || 100));
    const rows = db.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?").all(limit) as Array<{ id: number; actor_id: string | null; actor_email: string | null; action: string; target: string | null; details: string | null; created_at: string }>;
    return { entries: rows.map((r) => ({ id: r.id, actorId: r.actor_id, actorEmail: r.actor_email, action: r.action, target: r.target, details: parseJson<unknown>(r.details, null), createdAt: r.created_at })) };
  });
}

export function describePlugins(ctx: AppContext) {
  const settings = ctx.registry.settings();
  const users = new Map(listUsers(ctx.db).map((u) => [u.id, u]));
  return [...ctx.registry.plugins.values()].map(({ manifest: m, source, readme }) => {
    const s = settings.get(m.id);
    const owner = s?.owner_id ? users.get(s.owner_id) : undefined;
    return {
      id: m.id,
      name: m.name,
      version: m.version,
      description: m.description,
      category: m.category ?? (m.kind === "transforms" ? "Transformations" : "Other"),
      icon: m.icon ?? null,
      website: m.website ?? null,
      kind: m.kind,
      roles: m.roles ?? [],
      source,
      readme,
      objects: (m.objects ?? []).map((o) => ({ id: o.id, label: o.label, fieldCount: o.fields.length })),
      actions: (m.actions ?? []).map((a) => ({ id: a.id, label: a.label })),
      operations: (m.operations ?? []).map((o) => ({ id: o.id, label: o.label, ai: !!o.ai })),
      defaultGuidance: m.guidance ?? null,
      defaultSetupNotes: m.setup?.notes ?? null,
      docsUrl: m.setup?.docsUrl ?? null,
      enabled: s ? !!s.enabled : true,
      owner: owner ? { id: owner.id, name: owner.name, email: owner.email } : null,
      guidance: s?.guidance ?? null,
      setupNotes: s?.setup_notes ?? null,
      overrides: parseJson<{ disabledObjects?: string[]; disabledActions?: string[]; disabledOperations?: string[] }>(s?.overrides, {}),
      updatedAt: s?.updated_at ?? null,
    };
  });
}
