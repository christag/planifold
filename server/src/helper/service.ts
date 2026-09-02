import { analyzePlan, buildHandoff, buildSentence, renderHandoffMarkdown, type Catalog, type PieceData, type PlanData } from "@piecewise/shared";
import type { FastifyBaseLogger } from "fastify";
import type { SecretBox } from "../crypto.js";
import type { Db } from "../db/index.js";
import type { ProviderRow, Settings } from "../db/models.js";
import type { PluginRegistry } from "../plugins/registry.js";
import { applySuggestion } from "./apply.js";
import { fallbackResponse } from "./fallback.js";
import { briefPrompt, stateMessage, systemPrompt, type OrgContext } from "./prompt.js";
import { anthropicProvider } from "./providers/anthropic.js";
import { openaiProvider } from "./providers/openai.js";
import { HelperError, type ChatMessage, type LlmProvider } from "./providers/types.js";
import { HelperResponseSchema, type HelperFocus, type HelperIntent, type HelperResponse, type Suggestion } from "./schema.js";

export interface ReviewedSuggestion extends Suggestion {
  preview: string;
  applied: string[];
  dropped: string[];
  valid: boolean;
}

export interface HelperResult extends Omit<HelperResponse, "suggestions"> {
  suggestions: ReviewedSuggestion[];
  source: "model" | "rules";
  model: string | null;
  notice: string | null;
}

export class HelperService {
  constructor(
    private db: Db,
    private registry: PluginRegistry,
    private box: SecretBox,
    private settings: Settings,
    private log: FastifyBaseLogger,
  ) {}

  listProviders(): ProviderRow[] {
    return this.db.prepare("SELECT * FROM llm_providers ORDER BY created_at").all() as ProviderRow[];
  }
  getProvider(id: string): ProviderRow | undefined {
    return this.db.prepare("SELECT * FROM llm_providers WHERE id = ?").get(id) as ProviderRow | undefined;
  }
  activeRow(): ProviderRow | undefined {
    return this.db.prepare("SELECT * FROM llm_providers WHERE is_active = 1 LIMIT 1").get() as ProviderRow | undefined;
  }

  status(): { configured: boolean; provider: { label: string; kind: string; model: string } | null } {
    const row = this.activeRow();
    return { configured: !!row, provider: row ? { label: row.label, kind: row.kind, model: row.model } : null };
  }

  org(): OrgContext {
    return {
      orgName: this.settings.get<string>("orgName", ""),
      orgGuidance: this.settings.get<string>("orgGuidance", ""),
      preferredBuilder: this.settings.get<string>("preferredBuilder", ""),
    };
  }

  private build(row: ProviderRow): LlmProvider {
    let apiKey: string | null = null;
    if (row.api_key_enc) {
      try {
        apiKey = this.box.open(row.api_key_enc);
      } catch {
        throw new HelperError("The stored API key can't be decrypted. APP_SECRET probably changed; re-enter the key in Admin → AI.");
      }
    }
    if (row.kind === "anthropic") {
      if (!apiKey) throw new HelperError("The Anthropic provider has no API key.");
      return anthropicProvider({ apiKey, model: row.model, baseURL: row.base_url, label: row.label });
    }
    return openaiProvider({ kind: row.kind, apiKey, model: row.model, baseURL: row.base_url, label: row.label });
  }

  async testProvider(row: ProviderRow): Promise<{ ok: boolean; message: string }> {
    try {
      return await this.build(row).test();
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }

  private review(catalog: Catalog, pieces: PieceData[], s: Suggestion): ReviewedSuggestion {
    const existing = s.pieceId ? pieces.find((p) => p.id === s.pieceId) : undefined;
    const target: PieceData = existing && existing.kind === s.kind ? existing : { id: "preview", kind: s.kind, slots: {}, position: pieces.length };
    const r = applySuggestion(catalog, pieces, target, s.slots);
    const preview = buildSentence(r.piece, { catalog, pieces: [...pieces.filter((p) => p.id !== target.id), r.piece] }).text;
    return { ...s, pieceId: existing && existing.kind === s.kind ? existing.id : null, slots: s.slots.filter((x) => r.applied.includes(x.id)), preview, applied: r.applied, dropped: r.dropped, valid: r.applied.length > 0 };
  }

  async respond(args: { plan: PlanData; pieces: PieceData[]; history: ChatMessage[]; message: string; intent: HelperIntent; focus?: HelperFocus }): Promise<HelperResult> {
    const catalog = this.registry.catalog();
    const org = this.org();
    const row = this.activeRow();
    let response: HelperResponse;
    let source: HelperResult["source"] = "rules";
    let notice: string | null = null;
    let model: string | null = null;

    if (row) {
      try {
        const provider = this.build(row);
        const system = systemPrompt(catalog, org);
        const state = stateMessage(args.plan, args.pieces, catalog, args.focus, args.intent);
        const person = args.message.trim() || defaultMessage(args.intent);
        const messages: ChatMessage[] = [...args.history.slice(-12), { role: "user", content: `${state}\n\nPERSON SAYS: ${person}` }];
        response = await provider.structured(HelperResponseSchema, system, messages);
        source = "model";
        model = row.model;
      } catch (e) {
        this.log.warn({ err: e }, "helper model call failed; using rules");
        notice = e instanceof HelperError ? e.message : "The AI model didn't answer. Showing rule-based guidance instead.";
        response = fallbackResponse({ ...args, catalog, message: args.message, preferredBuilder: org.preferredBuilder, reason: "failed" });
      }
    } else {
      response = fallbackResponse({ ...args, catalog, message: args.message, preferredBuilder: org.preferredBuilder });
    }

    const suggestions = response.suggestions.slice(0, 6).map((s) => this.review(catalog, args.pieces, s));
    return { ...response, suggestions, source, model, notice };
  }

  async writeBrief(plan: PlanData, pieces: PieceData[]): Promise<{ brief: string; source: "model" | "rules" }> {
    const catalog = this.registry.catalog();
    const org = this.org();
    const doc = buildHandoff(plan, pieces, catalog, { orgGuidance: org.orgGuidance, preferredBuilder: org.preferredBuilder });
    const markdown = renderHandoffMarkdown(doc);
    const row = this.activeRow();
    if (row) {
      try {
        const { system, user } = briefPrompt(markdown, org);
        const brief = await this.build(row).text(system, [{ role: "user", content: user }]);
        if (brief.trim()) return { brief: brief.trim(), source: "model" };
      } catch (e) {
        this.log.warn({ err: e }, "brief generation failed; using template");
      }
    }
    return { brief: templateBrief(plan, pieces, catalog, org), source: "rules" };
  }
}

function defaultMessage(intent: HelperIntent): string {
  switch (intent) {
    case "breakdown":
      return "Break my thought into pieces.";
    case "slot":
      return "Help me fill this blank.";
    case "review":
      return "Review the plan before I hand it off.";
    default:
      return "What should I do next?";
  }
}

function templateBrief(plan: PlanData, pieces: PieceData[], catalog: Catalog, org: OrgContext): string {
  const a = analyzePlan(pieces, catalog);
  const ordered = [...pieces].sort((x, y) => x.position - y.position);
  const byKind = (k: PieceData["kind"]) => ordered.filter((p) => p.kind === k);
  const L: string[] = [];
  L.push("## Summary");
  L.push(`${plan.title}. In the planner's words: “${plan.thought.trim() || "no thought recorded"}”. ${byKind("input").length} input${byKind("input").length === 1 ? "" : "s"}, ${byKind("transform").length} transformation${byKind("transform").length === 1 ? "" : "s"}, ${byKind("output").length} output${byKind("output").length === 1 ? "" : "s"}.`);
  L.push("");
  L.push("## Steps");
  let n = 0;
  for (const kind of ["input", "transform", "output"] as const) for (const p of byKind(kind)) {
    const s = a.sentences[p.id]!;
    L.push(`${++n}. ${s.text}${s.ai ? " (needs a language model)" : ""}${p.notes?.trim() ? ` — note: ${p.notes.trim()}` : ""}`);
  }
  L.push("");
  L.push("## Data and access needed");
  const integs = new Set<string>();
  for (const p of ordered) {
    const v = p.slots.integration;
    if (v?.kind === "option") integs.add(v.id);
  }
  for (const id of integs) {
    const i = catalog.integrations.find((x) => x.id === id);
    if (i) L.push(`- ${i.name}${i.setupNotes ? `: ${i.setupNotes}` : ""}`);
  }
  if (!integs.size) L.push("- Nothing external yet.");
  L.push("");
  L.push("## Open questions");
  const qs = [...a.looseEnds.map((le) => `${le.pieceLabel}: ${le.placeholder}${le.note ? ` (${le.note})` : ""}`), ...a.nudges.filter((x) => x.level === "warn").map((x) => x.text)];
  L.push(...(qs.length ? qs.map((q) => `- ${q}`) : ["- None recorded."]));
  L.push("");
  L.push("## Suggested build approach");
  L.push(org.preferredBuilder ? `Build with ${org.preferredBuilder}, per organization guidance.` : "Follow the organization's usual automation platform; nothing in this plan requires a specific one.");
  if (org.orgGuidance) L.push(org.orgGuidance);
  return L.join("\n");
}
