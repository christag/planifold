import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app.js";
import { requireUser } from "../auth/plugin.js";
import { loadPlanFor } from "../plans/access.js";
import { addMessage, asPieceData, clearMessages, getPlan, listMessages, listPieces, updatePlan } from "../plans/repo.js";
import { badRequest } from "../errors.js";

const MAX_FACTS = 50;
const MAX_FACT_LENGTH = 500;

const Ask = z.object({
  message: z.string().max(4000).default(""),
  intent: z.enum(["chat", "breakdown", "slot", "review"]).default("chat"),
  focus: z.object({ pieceId: z.string(), slotId: z.string().optional() }).optional(),
});

export async function helperRoutes(app: FastifyInstance, opts: { ctx: AppContext }) {
  const { db, helper } = opts.ctx;

  app.get("/api/helper/status", async (req) => {
    requireUser(req);
    return helper.status();
  });

  app.post("/api/plans/:id/helper", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req) => {
    const { plan } = loadPlanFor(db, req, (req.params as { id: string }).id);
    const body = Ask.parse(req.body);
    if (body.intent === "chat" && !body.message.trim()) throw badRequest("Say something first.");
    const pieces = listPieces(db, plan.id).map(asPieceData);
    const history = listMessages(db, plan.id, 12).map((m) => ({ role: m.role, content: m.content }));
    const shown = body.message.trim() || (body.intent === "breakdown" ? "Break this into pieces for me." : body.intent === "slot" ? "Help me with this blank." : body.intent === "review" ? "Review the plan." : "");
    const userMessageId = addMessage(db, plan.id, "user", shown, { intent: body.intent, focus: body.focus ?? null });
    const planData = { id: plan.id, title: plan.title, thought: plan.thought, facts: plan.facts, status: plan.status };
    const result = await helper.respond({ plan: planData, pieces, history, message: body.message, intent: body.intent, focus: body.focus });
    const assistantId = addMessage(db, plan.id, "assistant", result.message, {
      suggestions: result.suggestions,
      questions: result.questions,
      remember: result.remember,
      source: result.source,
      model: result.model,
      notice: result.notice,
    });
    // Merge remembered facts into the plan as it is NOW, not as it was before
    // the model call, and stay within the limits the editor enforces.
    const current = getPlan(db, plan.id) ?? plan;
    const facts = [...current.facts];
    for (const f of result.remember) {
      const t = f.trim().slice(0, MAX_FACT_LENGTH);
      if (t && !facts.includes(t) && facts.length < MAX_FACTS) facts.push(t);
    }
    if (facts.length !== current.facts.length) updatePlan(db, plan.id, { facts });
    return { userMessageId, assistantId, ...result, facts };
  });

  app.post("/api/plans/:id/brief", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const { plan } = loadPlanFor(db, req, (req.params as { id: string }).id);
    const pieces = listPieces(db, plan.id).map(asPieceData);
    const { brief, source } = await helper.writeBrief({ id: plan.id, title: plan.title, thought: plan.thought, facts: plan.facts, status: plan.status }, pieces);
    updatePlan(db, plan.id, { brief });
    return { brief, source };
  });

  app.delete("/api/plans/:id/helper", async (req) => {
    const { plan } = loadPlanFor(db, req, (req.params as { id: string }).id);
    clearMessages(db, plan.id);
    return { ok: true };
  });
}
