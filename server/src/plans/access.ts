import type { FastifyRequest } from "fastify";
import { requireUser } from "../auth/plugin.js";
import type { Db } from "../db/index.js";
import type { Plan, User } from "../db/models.js";
import { forbidden, notFound } from "../errors.js";
import { getPlan } from "./repo.js";

/** Loads a plan the current user may work on: their own, or any plan for app admins. */
export function loadPlanFor(db: Db, req: FastifyRequest, id: string): { user: User; plan: Plan } {
  const user = requireUser(req);
  const plan = getPlan(db, id);
  if (!plan) throw notFound("That plan doesn't exist.");
  if (plan.ownerId !== user.id && user.role !== "app_admin") throw forbidden("This plan belongs to someone else.");
  return { user, plan };
}
