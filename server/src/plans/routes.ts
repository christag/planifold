import { buildHandoff, cleanPiece, renderHandoffMarkdown, type PieceData, type SlotValue } from "@piecewise/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app.js";
import { requireUser } from "../auth/plugin.js";
import { audit } from "../db/models.js";
import { badRequest, notFound } from "../errors.js";
import { applySuggestion, SuggestedSlotSchema } from "../helper/apply.js";
import { loadPlanFor } from "./access.js";
import { asPieceData, createPlan, deletePiece, deletePlan, getPiece, insertPiece, listMessages, listPieces, listPlans, reconcilePlan, savePiece, updatePlan } from "./repo.js";

const SlotValueSchema: z.ZodType<SlotValue> = z.union([
  z.object({ kind: z.literal("option"), id: z.string().min(1).max(200) }),
  z.object({ kind: z.literal("text"), text: z.string().max(2000) }),
  z.object({ kind: z.literal("ref"), pieceId: z.string().min(1).max(100) }),
  z.object({ kind: z.literal("unsure"), note: z.string().max(500).optional() }),
]);
const Slots = z.record(z.string().regex(/^[a-zA-Z0-9_.-]{1,80}$/), SlotValueSchema);

const PlanCreate = z.object({ title: z.string().max(160).optional(), thought: z.string().max(4000).default("") });
const PlanPatch = z.object({
  title: z.string().min(1).max(160).optional(),
  thought: z.string().max(4000).optional(),
  facts: z.array(z.string().max(500)).max(50).optional(),
  status: z.enum(["draft", "ready", "handed_off"]).optional(),
});
const PieceCreate = z.object({ kind: z.enum(["input", "transform", "output"]), slots: Slots.optional(), label: z.string().max(120).nullable().optional(), notes: z.string().max(4000).nullable().optional() });
const PiecePatch = z.object({ slots: Slots.optional(), label: z.string().max(120).nullable().optional(), notes: z.string().max(4000).nullable().optional() });
const Reorder = z.object({ ids: z.array(z.string()).min(1) });
const ApplySlot = SuggestedSlotSchema.extend({ id: z.string().regex(/^[a-zA-Z0-9_.-]{1,80}$/), value: z.string().max(2000) });
const Apply = z.object({ pieceId: z.string().nullable(), kind: z.enum(["input", "transform", "output"]), slots: z.array(ApplySlot).max(60), label: z.string().max(120).nullable().optional() });

function titleFromThought(thought: string): string {
  const t = thought.trim().replace(/\s+/g, " ");
  if (!t) return "Untitled plan";
  const cut = t.replace(/^(i want to|i'd like to|i would like to|please|can you|could you|help me)\s+/i, "");
  const words = cut.split(" ").slice(0, 8).join(" ");
  const title = words.charAt(0).toUpperCase() + words.slice(1);
  return title.length < cut.length ? `${title}…` : title;
}

export async function plansRoutes(app: FastifyInstance, opts: { ctx: AppContext }) {
  const { db, registry } = opts.ctx;

  const loadPlan = (req: Parameters<typeof loadPlanFor>[1], id: string) => loadPlanFor(db, req, id);

  app.get("/api/catalog", async (req) => {
    requireUser(req);
    const catalog = registry.catalog();
    return { catalog };
  });

  app.get("/api/plans", async (req) => {
    const user = requireUser(req);
    const q = req.query as { all?: string };
    const all = q.all === "1" && user.role === "app_admin";
    return { plans: listPlans(db, all ? null : user.id) };
  });

  app.post("/api/plans", async (req) => {
    const user = requireUser(req);
    const body = PlanCreate.parse(req.body);
    const plan = createPlan(db, user.id, { title: body.title?.trim() || titleFromThought(body.thought), thought: body.thought.trim() });
    // Every plan starts with one empty input: the first blank to fill.
    insertPiece(db, plan.id, { kind: "input" });
    audit(db, { id: user.id, email: user.email }, "plan.created", plan.id);
    return { plan, pieces: listPieces(db, plan.id), messages: [] };
  });

  app.get("/api/plans/:id", async (req) => {
    const { plan } = loadPlan(req, (req.params as { id: string }).id);
    return { plan, pieces: listPieces(db, plan.id), messages: listMessages(db, plan.id) };
  });

  app.patch("/api/plans/:id", async (req) => {
    const { plan, user } = loadPlan(req, (req.params as { id: string }).id);
    const body = PlanPatch.parse(req.body);
    const updated = updatePlan(db, plan.id, body);
    if (body.status && body.status !== plan.status) audit(db, { id: user.id, email: user.email }, "plan.status", plan.id, { status: body.status });
    return { plan: updated };
  });

  app.delete("/api/plans/:id", async (req) => {
    const { plan, user } = loadPlan(req, (req.params as { id: string }).id);
    deletePlan(db, plan.id);
    audit(db, { id: user.id, email: user.email }, "plan.deleted", plan.id, { title: plan.title });
    return { ok: true };
  });

  app.post("/api/plans/:id/pieces", async (req) => {
    const { plan } = loadPlan(req, (req.params as { id: string }).id);
    const body = PieceCreate.parse(req.body);
    const existing = listPieces(db, plan.id).map(asPieceData);
    const draft: PieceData = { id: "new", kind: body.kind, slots: body.slots ?? {}, label: body.label ?? null, notes: body.notes ?? null, position: existing.length };
    const { piece: cleaned } = cleanPiece(draft, { catalog: registry.catalog(), pieces: [...existing, draft] });
    const piece = insertPiece(db, plan.id, { kind: body.kind, slots: cleaned.slots, label: body.label ?? null, notes: body.notes ?? null });
    return { piece };
  });

  app.patch("/api/plans/:id/pieces/:pid", async (req) => {
    const { plan } = loadPlan(req, (req.params as { id: string }).id);
    const pid = (req.params as { pid: string }).pid;
    const body = PiecePatch.parse(req.body);
    const current = getPiece(db, plan.id, pid);
    if (!current) throw notFound("That piece doesn't exist.");
    let slots = current.slots;
    let dropped: string[] = [];
    if (body.slots) {
      const others = listPieces(db, plan.id).map(asPieceData);
      const draft: PieceData = { ...asPieceData(current), slots: body.slots };
      const { piece: cleaned } = cleanPiece(draft, { catalog: registry.catalog(), pieces: others.map((p) => (p.id === pid ? draft : p)) });
      dropped = Object.keys(body.slots).filter((k) => !(k in cleaned.slots));
      slots = cleaned.slots;
    }
    const piece = savePiece(db, plan.id, pid, { slots, label: body.label, notes: body.notes });
    // A changed reference can invalidate downstream pieces.
    const pieces = body.slots ? reconcilePlan(db, plan.id, registry.catalog()) : listPieces(db, plan.id);
    return { piece: pieces.find((p) => p.id === pid) ?? piece, pieces, dropped };
  });

  app.delete("/api/plans/:id/pieces/:pid", async (req) => {
    const { plan } = loadPlan(req, (req.params as { id: string }).id);
    const pid = (req.params as { pid: string }).pid;
    if (!getPiece(db, plan.id, pid)) throw notFound("That piece doesn't exist.");
    deletePiece(db, plan.id, pid);
    const pieces = reconcilePlan(db, plan.id, registry.catalog());
    return { pieces };
  });

  app.post("/api/plans/:id/pieces/reorder", async (req) => {
    const { plan } = loadPlan(req, (req.params as { id: string }).id);
    const body = Reorder.parse(req.body);
    const pieces = listPieces(db, plan.id);
    const known = new Set(pieces.map((p) => p.id));
    if (!body.ids.every((id) => known.has(id)) || new Set(body.ids).size !== body.ids.length) throw badRequest("The order lists unknown or repeated pieces.");
    const tx = db.transaction(() => {
      let pos = 0;
      for (const id of body.ids) savePiece(db, plan.id, id, { position: pos++ });
      for (const p of pieces) if (!body.ids.includes(p.id)) savePiece(db, plan.id, p.id, { position: pos++ });
    });
    tx();
    return { pieces: listPieces(db, plan.id) };
  });

  /** Applies a helper suggestion through the grammar, creating or updating a piece. */
  app.post("/api/plans/:id/pieces/apply", async (req) => {
    const { plan } = loadPlan(req, (req.params as { id: string }).id);
    const body = Apply.parse(req.body);
    const catalog = registry.catalog();
    const existing = listPieces(db, plan.id).map(asPieceData);
    let target: PieceData;
    if (body.pieceId) {
      const found = existing.find((p) => p.id === body.pieceId);
      if (!found) throw notFound("That piece doesn't exist any more.");
      if (found.kind !== body.kind) throw badRequest("A piece can't change kind.");
      target = found;
    } else {
      target = { id: "new", kind: body.kind, slots: {}, label: body.label ?? null, notes: null, position: existing.length };
    }
    const result = applySuggestion(catalog, existing, target, body.slots);
    let pieceId = body.pieceId;
    if (!pieceId) pieceId = insertPiece(db, plan.id, { kind: body.kind, slots: result.piece.slots, label: body.label ?? null }).id;
    else savePiece(db, plan.id, pieceId, { slots: result.piece.slots });
    const pieces = reconcilePlan(db, plan.id, catalog);
    return { pieceId, pieces, applied: result.applied, dropped: result.dropped };
  });

  app.get("/api/plans/:id/handoff", async (req) => {
    const { plan } = loadPlan(req, (req.params as { id: string }).id);
    const pieces = listPieces(db, plan.id).map(asPieceData);
    const settings = opts.ctx.settings;
    const doc = buildHandoff(
      { id: plan.id, title: plan.title, thought: plan.thought, facts: plan.facts, status: plan.status },
      pieces,
      registry.catalog(),
      { orgGuidance: settings.get<string>("orgGuidance", ""), preferredBuilder: settings.get<string>("preferredBuilder", ""), brief: plan.brief },
    );
    return { doc, markdown: renderHandoffMarkdown(doc) };
  });
}
