/**
 * The helper that is always there. When no language model is configured
 * (or one fails), this produces useful, honest guidance from the grammar
 * itself: what the catalog offers, what the plan still needs, and
 * keyword-based guesses the person can accept or ignore.
 */
import { analyzePlan, buildSentence, type Catalog, type PieceData, type PlanData, type Token } from "@piecewise/shared";
import type { HelperFocus, HelperIntent, HelperResponse, Suggestion } from "./schema.js";

const ALIASES: Record<string, string[]> = {
  gmail: ["gmail", "email", "emails", "mail", "inbox", "contacts", "contact"],
  outlook: ["outlook", "office 365", "o365", "exchange"],
  slack: ["slack", "channel", "dm"],
  "microsoft-teams": ["teams"],
  jira: ["jira", "ticket", "tickets", "issue", "issues", "sprint", "epic"],
  servicenow: ["servicenow", "incident", "incidents", "service now"],
  zendesk: ["zendesk", "support ticket"],
  monday: ["monday", "board", "boards"],
  "google-sheets": ["sheet", "sheets", "spreadsheet", "spreadsheets"],
  "google-drive": ["google drive", "drive"],
  sharepoint: ["sharepoint", "onedrive"],
  confluence: ["confluence", "wiki"],
  notion: ["notion"],
  salesforce: ["salesforce", "opportunity", "opportunities", "lead", "leads", "crm"],
  workday: ["workday", "employee", "employees", "hr", "new hire", "new hires"],
  bamboohr: ["bamboo", "bamboohr"],
  "sql-database": ["database", "table", "sql", "query"],
  "http-api": ["api", "webhook", "endpoint"],
  "file-share": ["folder", "shared folder", "file share", "sftp", "file server"],
  "web-rss": ["rss", "feed", "website", "web page", "article", "articles", "news"],
  "google-calendar": ["calendar", "meeting", "meetings", "event", "events"],
  report: ["report", "document", "summary", "digest", "pdf", "tell me", "show me", "notify", "notification", "let me know"],
};

const SEND_WORDS = ["send", "email", "mail", "forward", "share with", "message"];

function score(text: string, integ: { id: string; name: string; objects: Array<{ label: string; singular: string }> }): number {
  let n = 0;
  const words = [integ.name.toLowerCase(), ...(ALIASES[integ.id] ?? []), ...integ.objects.flatMap((o) => [o.label, o.singular])];
  for (const w of new Set(words)) if (w.length > 2 && text.includes(w)) n += w.length > 5 ? 2 : 1;
  return n;
}

function extractTopic(text: string): string | undefined {
  const m = text.match(/\b(?:about|regarding|containing|mentioning|with|on)\s+[“"']?([a-z0-9][a-z0-9 \-']{1,40}?)[”"']?(?=\s+(?:and|to|from|into|then|so|that|in)\b|[.,;!?]|$)/i);
  return m?.[1]?.trim();
}

export function fallbackResponse(input: { plan: PlanData; pieces: PieceData[]; catalog: Catalog; intent: HelperIntent; focus?: HelperFocus; message: string; preferredBuilder?: string; reason?: "none" | "failed" }): HelperResponse {
  const { plan, pieces, catalog, intent, focus, message } = input;
  const analysis = analyzePlan(pieces, catalog);
  const text = `${plan.thought} ${message}`.toLowerCase();
  const questions: string[] = [];
  const suggestions: Suggestion[] = [];
  const remember: string[] = [];
  const preface =
    input.reason === "failed"
      ? "The AI model didn't answer, so this comes from the plan's own rules and catalog instead."
      : "The AI helper isn't switched on, so this comes from the plan's own rules and catalog. An app administrator can add a model under Admin → AI.";

  if (intent === "slot" && focus) {
    const piece = pieces.find((p) => p.id === focus.pieceId);
    const s = piece ? buildSentence(piece, { catalog, pieces }) : undefined;
    const slot = s?.tokens.find((t): t is Extract<Token, { type: "slot" }> => t.type === "slot" && t.spec.id === focus.slotId);
    if (piece && slot) {
      const names = slot.spec.options.slice(0, 8).map((o) => o.label);
      const rest = slot.spec.options.length > 8 ? ` and ${slot.spec.options.length - 8} more` : "";
      const lines = [slot.spec.help ?? `This blank is “${slot.spec.placeholder}”.`];
      if (names.length) lines.push(`You can choose ${names.join(", ")}${rest}.`);
      if (slot.spec.allowText) lines.push(`Or type your own${slot.spec.textHint ? ` (${slot.spec.textHint})` : ""}.`);
      if (!names.length && !slot.spec.allowText) lines.push("Nothing is available here yet. Fill the blanks before it, or add the piece it should point at.");
      const hit =
        slot.spec.options.find((o) => o.label.length > 3 && text.includes(o.label.toLowerCase())) ??
        (slot.spec.id === "integration"
          ? slot.spec.options
              .map((o) => ({ o, n: score(text, catalog.integrations.find((i) => i.id === o.id) ?? { id: o.id, name: o.label, objects: [] }) }))
              .filter((x) => x.n > 0)
              .sort((a, b) => b.n - a.n)[0]?.o
          : undefined);
      if (hit)
        suggestions.push({
          title: `Use “${hit.label}”`,
          pieceId: piece.id,
          kind: piece.kind,
          slots: [{ id: slot.spec.id, type: hit.pieceId ? "ref" : "option", value: hit.pieceId ?? hit.id }],
          why: "It matches a word in your thought.",
        });
      if (slot.spec.optional) lines.push("This one is optional. Leaving it blank is a real choice, not a gap.");
      return { message: lines.join(" "), suggestions, questions, remember };
    }
  }

  if (intent === "breakdown") {
    const inputs = catalog.integrations.filter((i) => i.roles.includes("input"));
    const outputs = catalog.integrations.filter((i) => i.roles.includes("output"));
    const bestIn = [...inputs].sort((a, b) => score(text, b) - score(text, a))[0];
    const wantsSend = SEND_WORDS.some((w) => text.includes(w));
    const bestOut = [...outputs].sort((a, b) => score(text, b) - score(text, a)).find((i) => score(text, i) > 0 && (wantsSend || i.id === "report")) ?? outputs.find((i) => i.id === "report") ?? outputs[0];
    const topic = extractTopic(plan.thought);
    const emptyInput = pieces.find((p) => p.kind === "input" && buildSentence(p, { catalog, pieces }).status === "empty");

    if (bestIn && score(text, bestIn) > 0) {
      const obj = bestIn.objects.find((o) => text.includes(o.label) || text.includes(o.singular)) ?? bestIn.objects[0];
      const slots: Suggestion["slots"] = [{ id: "integration", type: "option", value: bestIn.id }];
      if (obj) {
        slots.push({ id: "object", type: "option", value: obj.id });
        const field = obj.fields.find((f) => f.id === "subject") ?? obj.fields.find((f) => f.id === "title" || f.id === "name") ?? obj.fields.find((f) => f.type === "string" || f.type === "text");
        if (topic && field) {
          slots.push({ id: "filter.0.field", type: "option", value: field.id }, { id: "filter.0.op", type: "option", value: "contains" }, { id: "filter.0.value", type: "text", value: topic });
          questions.push(`Does “${topic}” show up in the ${field.label}, the body, or a label? The filter decides what counts.`);
        }
      }
      suggestions.push({
        title: `Start with ${obj ? obj.label : "something"} from ${bestIn.name}`,
        pieceId: emptyInput?.id ?? null,
        kind: "input",
        slots,
        why: `Your thought mentions ${bestIn.name.toLowerCase().includes("a ") ? "a " : ""}${bestIn.name}-like source.`,
      });
    } else {
      questions.push("Where does the information live today? Pick the input's first blank to see what's available.");
    }

    const t = text;
    const ops = catalog.operations;
    const opGuess =
      (t.includes("summar") && ops.find((o) => o.id === "summarize")) ||
      (t.includes("translat") && ops.find((o) => o.id === "translate")) ||
      ((t.includes("duplicate") || t.includes("dedup")) && ops.find((o) => o.id === "dedupe")) ||
      ((t.includes("categor") || t.includes("classif") || t.includes("sort into")) && ops.find((o) => o.id === "classify")) ||
      ((t.includes("pull out") || t.includes("extract")) && ops.find((o) => o.id === "extract")) ||
      ((t.includes("combine") || t.includes("join") || t.includes("match")) && ops.find((o) => o.id === "combine")) ||
      (t.includes("count") && ops.find((o) => o.id === "count")) ||
      undefined;
    if (opGuess) suggestions.push({ title: `Then ${opGuess.label}`, pieceId: null, kind: "transform", slots: [{ id: "operation", type: "option", value: opGuess.id }], why: "Your thought hints at this step. Pick its source after adding it." });

    if (bestOut) {
      const action = bestOut.actions[0];
      suggestions.push({
        title: `End with ${action ? action.label : "an output"} via ${bestOut.name}`,
        pieceId: null,
        kind: "output",
        slots: [{ id: "integration", type: "option", value: bestOut.id }, ...(action ? [{ id: "action", type: "option" as const, value: action.id }] : [])],
        why: wantsSend ? "You said to send it somewhere." : "When in doubt, start by just seeing the result.",
      });
    }
    if (text.includes("friend") || text.includes("team") || text.includes("everyone")) questions.push("Who exactly receives this: a contact group, a spreadsheet of people, or addresses you'll type?");
    questions.push("When should this run: once by hand, on a schedule, or whenever something new arrives?");
    const msg = [
      preface,
      `Every plan needs an input (where the information is) and an expected output (where it ends up). Transformations go in between only when the information has to change on the way.`,
      suggestions.length ? "Apply the suggestions that fit, then fill the remaining blanks one at a time." : "Start by filling the first blank of the input.",
    ].join(" ");
    return { message: msg, suggestions, questions: questions.slice(0, 3), remember };
  }

  // chat / review
  const lines: string[] = [];
  const asksBuild = /\b(build|built|n8n|zapier|make\.com|power automate|routine|routines|who builds)\b/.test(text);
  if (asksBuild && input.preferredBuilder) lines.push(`When this is handed off, your organization prefers to build with ${input.preferredBuilder}.`);
  const nudges = analysis.nudges.filter((n) => n.level !== "info" || intent === "review").slice(0, 4);
  if (analysis.ready) lines.push("Every piece is complete and connected. Open Handoff to review and export the plan.");
  else if (nudges.length) lines.push(...nudges.map((n) => n.text));
  else lines.push(analysis.nudges[0]?.text ?? "Fill the blank in front of you; the sentence will grow as you go.");
  for (const le of analysis.looseEnds.slice(0, 3)) questions.push(`Loose end in “${le.pieceLabel}”: ${le.placeholder}${le.note ? ` (${le.note})` : ""}.`);
  if (!lines.some((l) => l.startsWith("The AI helper"))) lines.unshift(preface);
  return { message: lines.join(" "), suggestions, questions, remember };
}
