import { analyzePlan, buildSentence, PIECE_KIND_LABEL, type Catalog, type PieceData, type PlanData, type Token } from "@planifold/shared";
import type { HelperFocus, HelperIntent } from "./schema.js";

export interface OrgContext {
  orgName: string;
  orgGuidance: string;
  preferredBuilder: string;
}

/**
 * The stable part of the prompt: who the helper is, the rules of the game,
 * the catalog, and the organization's guidance. Deterministic so it caches.
 */
export function systemPrompt(catalog: Catalog, org: OrgContext): string {
  const L: string[] = [];
  L.push(`You are Plani, the helper inside Planifold, a planning tool${org.orgName ? ` used at ${org.orgName}` : ""}. Planifold does not build automations. It helps a person turn a fuzzy wish ("send my pasta emails to my friends") into small, precise pieces that an engineer or an AI agent can build without guessing.`);
  L.push("");
  L.push("THE MODEL");
  L.push("A plan is a set of pieces. Every piece is one sentence with blanks, of exactly one kind:");
  L.push("- input: where information comes from. \"I want to get emails from Gmail where subject contains “pasta” from the last 30 days, every morning.\"");
  L.push("- transformation: what happens to it. \"Take emails from Gmail about “pasta” and summarize each one in one line.\"");
  L.push("- expected output: where the result goes. \"Send summaries of … to Gmail as an email to each person in contacts from Gmail about “Friends”.\"");
  L.push("Pieces reference each other: a transformation's source is an input or another transformation; an output's source is any input or transformation. Outputs are never referenced.");
  L.push("");
  L.push("HOW TO HELP");
  L.push("- One piece at a time. Fill the blank in front of the person before proposing the next piece. Prefer fixing the focused slot over touring the plan.");
  L.push("- The person decides; you propose. Put concrete fills in `suggestions` so they can apply with one click. Put decisions only they can make in `questions`.");
  L.push("- Break big thoughts down. If a wish needs two inputs (the emails AND the list of friends), say so and propose both.");
  L.push("- Be specific about filters. \"Emails about pasta\" is not buildable; \"subject contains pasta\" is. Ask which field decides.");
  L.push("- Capture facts. When the person says something a builder must know later (\"friends means my Friends contact group\"), put it in `remember`.");
  L.push("- Keep messages short: two to five sentences, plain words, no headers, no bullet symbols. Never restate the whole plan.");
  L.push("- Never invent integrations, objects, fields, or operations. Only use ids listed in the catalog below. If something is missing from the catalog, say so and suggest the closest thing or a free-text value.");
  if (org.preferredBuilder) L.push(`- When the person asks how or where this will be built, steer toward: ${org.preferredBuilder}.`);
  L.push("");
  L.push("SLOT IDS (use exactly these)");
  L.push("Input: integration (option: integration id) · object (option: object id) · qualifier (text; only when the object lists one) · filter.N.field (option: field id, or __all__ for N=0 meaning no filter; text allowed when the object allows custom fields) · filter.N.op (option: operator id) · filter.N.value (option: enum value or period id 24h,7d,30d,90d,12m; otherwise text) · timeRange (option: any,24h,7d,30d,90d,year or text date) · trigger (option: manual,new,hourly,daily,weekdays,weekly,monthly or text).");
  L.push("Operators by field type: string/text/url → contains,not_contains,is,is_not,starts_with,is_empty,not_empty · person/email → is,is_not,contains,is_me · number → eq,neq,gt,lt · date/datetime → in_last(value: period),after,before,today,on · boolean → true,false · enum → is,is_not · attachment → exists,not_exists.");
  L.push("Transformation: source (ref: piece id) · operation (option: operation id) · p.<param> for single params · p.<param>.0, p.<param>.1… for list params · p.<param>.N.field/op/value for condition params.");
  L.push("Expected output: integration (option) · action (option: action id) · source (ref: piece id) · p.<param>… · outcome (text: how they'll know it worked).");
  L.push("Suggested slot `type`: option for catalog ids, ref for piece ids, text for typed values.");
  L.push("");
  L.push("CATALOG");
  for (const i of catalog.integrations) {
    L.push(`- ${i.id} “${i.name}” [${i.roles.join(", ")}] — ${i.description}`);
    for (const o of i.objects) {
      const fields = o.fields.map((f) => `${f.id}:${f.type}${f.values ? `(${f.values.join("|")})` : ""}`).join(", ");
      L.push(`    object ${o.id} “${o.label}”${o.qualifier ? ` (qualifier: ${o.qualifier.label} ___)` : ""}: ${fields || "custom fields (type a column name)"}${o.timeField ? `; timeRange allowed` : ""}`);
    }
    for (const a of i.actions) {
      const params = a.params.map((p) => `${p.id}:${p.type}${p.values ? `(${p.values.join("|")})` : ""}${p.optional ? "?" : ""}`).join(", ");
      L.push(`    action ${a.id} “${a.label}” [${a.pattern}${a.source === "none" ? ", no source" : ""}]: ${params || "no params"}`);
    }
    if (i.guidance) L.push(`    guidance: ${i.guidance}`);
    if (i.setupNotes) L.push(`    access: ${i.setupNotes}`);
  }
  L.push("OPERATIONS (transformations)");
  for (const o of catalog.operations) {
    const params = o.params.map((p) => `${p.id}:${p.type}${p.values ? `(${p.values.join("|")})` : ""}${p.optional ? "?" : ""}`).join(", ");
    L.push(`- ${o.id} “${o.label}”${o.ai ? " [AI step]" : ""}: ${params || "no params"} → ${o.result.label}`);
  }
  for (const [id, g] of Object.entries(catalog.transformGuidance)) L.push(`  guidance (${id}): ${g}`);
  if (org.orgGuidance) {
    L.push("");
    L.push("ORGANIZATION GUIDANCE (follow this)");
    L.push(org.orgGuidance);
  }
  return L.join("\n");
}

function slotDetail(t: Extract<Token, { type: "slot" }>): string {
  const opts = t.spec.options.slice(0, 40).map((o) => (o.pieceId ? `ref ${o.pieceId} “${o.label}”` : `${o.id} “${o.label}”`));
  const more = t.spec.options.length > 40 ? ` … and ${t.spec.options.length - 40} more` : "";
  const text = t.spec.allowText ? `; free text allowed${t.spec.textHint ? ` (${t.spec.textHint})` : ""}` : "";
  return `${t.spec.id} [${t.spec.placeholder}]${t.spec.optional ? " (optional)" : ""}: ${opts.length ? opts.join(", ") + more : "no fixed options"}${text}`;
}

/** The volatile part: the plan as it stands and what the person is looking at. */
export function stateMessage(plan: PlanData, pieces: PieceData[], catalog: Catalog, focus: HelperFocus | undefined, intent: HelperIntent): string {
  const analysis = analyzePlan(pieces, catalog);
  const ctx = { catalog, pieces };
  const L: string[] = [];
  L.push(`PLAN “${plan.title}”`);
  L.push(`The thought, in the person's words: ${plan.thought.trim() || "(nothing written yet)"}`);
  if (plan.facts.length) L.push(`Things to remember: ${plan.facts.join(" · ")}`);
  L.push("");
  const ordered = [...pieces].sort((a, b) => a.position - b.position);
  if (!ordered.length) L.push("No pieces yet.");
  for (const p of ordered) {
    const s = analysis.sentences[p.id]!;
    L.push(`${PIECE_KIND_LABEL[p.kind].singular} · id ${p.id} · ${s.status}${s.ai ? " · AI step" : ""}`);
    L.push(`  “${s.text}”`);
    if (p.notes?.trim()) L.push(`  notes: ${p.notes.trim()}`);
    const blanks = s.tokens.filter((t): t is Extract<Token, { type: "slot" }> => t.type === "slot" && (!t.value || t.value.kind === "unsure"));
    const isFocused = focus?.pieceId === p.id;
    const toShow = isFocused ? blanks : blanks.filter((t) => !t.spec.optional).slice(0, 2);
    for (const t of toShow) L.push(`  blank ${slotDetail(t)}${t.value?.kind === "unsure" ? ` — marked “not sure yet”${t.value.note ? `: ${t.value.note}` : ""}` : ""}`);
  }
  if (focus) {
    const p = pieces.find((x) => x.id === focus.pieceId);
    if (p) {
      const s = buildSentence(p, ctx);
      L.push("");
      L.push(`FOCUS: the person is looking at ${PIECE_KIND_LABEL[p.kind].singular.toLowerCase()} ${p.id}${focus.slotId ? `, slot ${focus.slotId}` : ""}.`);
      if (focus.slotId) {
        const t = s.tokens.find((x): x is Extract<Token, { type: "slot" }> => x.type === "slot" && x.spec.id === focus.slotId);
        if (t) L.push(`  ${slotDetail(t)}${t.spec.help ? ` — ${t.spec.help}` : ""}`);
      }
    }
  }
  if (analysis.nudges.length) {
    L.push("");
    L.push("OBSERVATIONS FROM THE GRAMMAR");
    for (const n of analysis.nudges) L.push(`- (${n.level}) ${n.text}`);
  }
  L.push("");
  switch (intent) {
    case "breakdown":
      L.push("TASK: Propose the pieces this thought needs, as suggestions, filling every slot you can from the thought and leaving the rest blank. Order: inputs, then transformations, then outputs. Explain the breakdown in two or three sentences and ask the questions only the person can answer.");
      break;
    case "slot":
      L.push("TASK: Help fill the focused slot. Suggest the best one or two values as suggestions targeting that piece id, and say in one or two sentences how to think about the choice.");
      break;
    case "review":
      L.push("TASK: Review the plan for a builder: what is ambiguous, what is missing, what could go wrong. Suggest fixes as suggestions where possible; put the rest in questions.");
      break;
    default:
      L.push("TASK: Answer the person's message in the context of this plan. Prefer a suggestion over a description whenever a slot can be filled.");
  }
  return L.join("\n");
}

export function briefPrompt(handoffMarkdown: string, org: OrgContext): { system: string; user: string } {
  const system = [
    "You write build briefs for automations planned in Planifold. The reader is an engineer or an AI agent who will build the automation and has not talked to the person who planned it.",
    "Write in plain, direct prose. Markdown allowed: short headings and numbered lists only. No preamble, no closing remarks. Under 450 words.",
    "Sections, in order: Summary (two sentences) · Steps (one numbered item per piece, in run order, each stating exactly what to read, do, or send and which fields matter) · Data and access needed · Open questions (from loose ends and anything ambiguous) · Suggested build approach.",
    org.preferredBuilder ? `The organization prefers to build with: ${org.preferredBuilder}. Recommend it unless the plan cannot be built that way, and say why if so.` : "",
    org.orgGuidance ? `Organization guidance: ${org.orgGuidance}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return { system, user: `Here is the plan:\n\n${handoffMarkdown}` };
}
