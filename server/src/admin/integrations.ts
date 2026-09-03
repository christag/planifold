import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app.js";
import { requireUser } from "../auth/plugin.js";
import { audit } from "../db/models.js";
import { forbidden, notFound } from "../errors.js";
import { describePlugins } from "./routes.js";

const Patch = z.object({
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

/**
 * Integration administrators own the systems upstream and downstream of
 * Planifold. They can tune how their integrations are described and
 * guided, but only app administrators enable, disable, or reassign them.
 */
export async function integrationRoutes(app: FastifyInstance, opts: { ctx: AppContext }) {
  const { db, registry } = opts.ctx;

  app.get("/api/integrations", async (req) => {
    const user = requireUser(req);
    const all = describePlugins(opts.ctx);
    const mine = user.role === "app_admin" ? all : all.filter((p) => p.owner?.id === user.id);
    return { plugins: mine, canManage: user.role !== "user" };
  });

  app.patch("/api/integrations/:id", async (req) => {
    const user = requireUser(req);
    const id = (req.params as { id: string }).id;
    if (!registry.plugins.has(id)) throw notFound("That integration isn't loaded.");
    const current = registry.settings().get(id);
    const owns = current?.owner_id === user.id && user.role === "integration_admin";
    if (!owns && user.role !== "app_admin") throw forbidden("You don't manage this integration.");
    const body = Patch.parse(req.body);
    registry.updateSettings(id, body);
    audit(db, { id: user.id, email: user.email }, "integration.updated", id, body);
    return { plugin: describePlugins(opts.ctx).find((p) => p.id === id) };
  });
}
