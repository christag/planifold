import { describe, expect, it } from "vitest";
import { analyzePlan, buildHandoff, buildSentence, cleanPiece, fieldsOf, renderHandoffMarkdown, safeParseManifest, tokensToText, withSlot } from "../src/index.js";
import { loadCatalog, opt, piece, ref, txt, unsure } from "./helpers.js";

const catalog = loadCatalog();
const ctx = (...pieces: ReturnType<typeof piece>[]) => ({ catalog, pieces });

describe("input sentences", () => {
  it("starts with a single blank", () => {
    const p = piece("input");
    const s = buildSentence(p, ctx(p));
    expect(s.text).toBe("From [somewhere]");
    expect(s.status).toBe("empty");
    expect(s.missing).toEqual(["integration"]);
    const slot = s.tokens.find((t) => t.type === "slot");
    expect(slot && slot.type === "slot" && slot.spec.options.map((o) => o.id)).toContain("gmail");
    expect(slot && slot.type === "slot" && slot.spec.options.map((o) => o.id)).not.toContain("report");
  });

  it("restructures once the integration is chosen", () => {
    const p = piece("input", { integration: opt("gmail") });
    const s = buildSentence(p, ctx(p));
    expect(s.text).toBe("I want to get [what?] from Gmail");
    expect(s.status).toBe("partial");
    expect(s.autoLabel).toBe("Gmail data");
  });

  it("asks which ones after the object", () => {
    const p = piece("input", { integration: opt("gmail"), object: opt("emails") });
    const s = buildSentence(p, ctx(p));
    expect(s.text).toBe("I want to get emails from Gmail where [which ones?]");
    expect(s.missing).toEqual(["filter.0.field"]);
  });

  it("builds a complete filter clause and then offers optional extras", () => {
    const p = piece("input", {
      integration: opt("gmail"),
      object: opt("emails"),
      "filter.0.field": opt("subject"),
      "filter.0.op": opt("contains"),
      "filter.0.value": txt("pasta"),
    });
    const s = buildSentence(p, ctx(p));
    expect(s.text).toBe("I want to get emails from Gmail where subject contains “pasta”.");
    expect(s.status).toBe("complete");
    expect(s.label).toBe("emails from Gmail about “pasta”");
    const optional = s.tokens.filter((t) => t.type === "slot" && t.spec.optional).map((t) => (t.type === "slot" ? t.spec.id : ""));
    expect(optional).toEqual(["filter.1.field", "timeRange", "trigger"]);
  });

  it("supports 'all of them' in place of a filter", () => {
    const p = piece("input", { integration: opt("gmail"), object: opt("contacts"), "filter.0.field": opt("__all__") });
    const s = buildSentence(p, ctx(p));
    expect(s.text).toBe("I want to get all contacts from Gmail.");
    expect(s.status).toBe("complete");
    expect(s.label).toBe("all contacts from Gmail");
  });

  it("renders time range and trigger", () => {
    const p = piece("input", {
      integration: opt("gmail"),
      object: opt("emails"),
      "filter.0.field": opt("__all__"),
      timeRange: opt("30d"),
      trigger: opt("daily"),
    });
    const s = buildSentence(p, ctx(p));
    expect(s.text).toBe("I want to get all emails from Gmail from the last 30 days, every morning.");
  });

  it("chains conditions with 'and' and typed operators", () => {
    const p = piece("input", {
      integration: opt("monday"),
      object: opt("items"),
      "filter.0.field": opt("status"),
      "filter.0.op": opt("is"),
      "filter.0.value": opt("Stuck"),
      "filter.1.field": opt("due_date"),
      "filter.1.op": opt("in_last"),
      "filter.1.value": opt("7d"),
    });
    const s = buildSentence(p, ctx(p));
    expect(s.text).toBe("I want to get items from Monday.com where status is Stuck and due date is in the last 7 days.");
    expect(s.status).toBe("complete");
  });

  it("uses a qualifier and custom field names for spreadsheets", () => {
    const p = piece("input", { integration: opt("google-sheets"), object: opt("rows"), qualifier: txt("Budget 2026") });
    const s = buildSentence(p, ctx(p));
    expect(s.text).toBe("I want to get rows from Google Sheets in the spreadsheet “Budget 2026” where [which ones?]");
    const withFilter = withSlot(withSlot(withSlot(p, "filter.0.field", txt("Owner")), "filter.0.op", opt("is")), "filter.0.value", txt("Chris"));
    expect(buildSentence(withFilter, ctx(withFilter)).text).toBe("I want to get rows from Google Sheets in the spreadsheet “Budget 2026” where “Owner” is “Chris”.");
  });

  it("marks unsure slots as loose ends without counting them as filled", () => {
    const p = piece("input", { integration: opt("gmail"), object: opt("emails"), "filter.0.field": unsure("maybe by label?") });
    const s = buildSentence(p, ctx(p));
    expect(s.status).toBe("partial");
    expect(s.unsure).toEqual([{ slotId: "filter.0.field", placeholder: "which ones?", note: "maybe by label?" }]);
    expect(s.text).toContain("[not sure yet: which ones?]");
  });

  it("prunes stale slots when an earlier choice changes", () => {
    const p = piece("input", { integration: opt("monday"), object: opt("emails"), "filter.0.field": opt("subject") });
    const { piece: cleaned, sentence } = cleanPiece(p, ctx(p));
    expect(Object.keys(cleaned.slots)).toEqual(["integration"]);
    expect(sentence.text).toBe("I want to get [what?] from Monday.com");
  });
});

describe("transformations", () => {
  const emails = piece("input", {
    integration: opt("gmail"),
    object: opt("emails"),
    "filter.0.field": opt("subject"),
    "filter.0.op": opt("contains"),
    "filter.0.value": txt("pasta"),
  });

  it("offers other pieces as the source", () => {
    const t = piece("transform");
    const s = buildSentence(t, ctx(emails, t));
    expect(s.text).toBe("Take [a piece]");
    const slot = s.tokens.find((x) => x.type === "slot");
    expect(slot && slot.type === "slot" ? slot.spec.options : []).toEqual([
      expect.objectContaining({ pieceId: emails.id, label: "emails from Gmail about “pasta”", group: "Inputs" }),
    ]);
  });

  it("completes an AI step and derives fields", () => {
    const t = piece("transform", { source: ref(emails.id), operation: opt("summarize"), "p.length": opt("in one line") });
    const s = buildSentence(t, ctx(emails, t));
    expect(s.text).toBe("Take emails from Gmail about “pasta” and summarize each one in one line.");
    expect(s.status).toBe("complete");
    expect(s.ai).toBe(true);
    expect(s.label).toBe("summaries of emails from Gmail about “pasta”");
    const fields = fieldsOf(t.id, ctx(emails, t)).fields.map((f) => f.id);
    expect(fields).toContain("subject");
    expect(fields).toContain("summary");
  });

  it("filters on fields derived from an upstream extraction", () => {
    const ex = piece("transform", { source: ref(emails.id), operation: opt("extract"), "p.items.0": txt("the recipe name"), "p.items.1": txt("the cook time") });
    const sEx = buildSentence(ex, ctx(emails, ex));
    expect(sEx.text).toBe("Take emails from Gmail about “pasta” and pull out “the recipe name” and “the cook time” from each one.");
    expect(sEx.label).toBe("the recipe name, the cook time from emails from Gmail about “pasta”");
    const f = piece("transform", { source: ref(ex.id), operation: opt("filter"), "p.condition.0.field": opt("the_cook_time"), "p.condition.0.op": opt("contains"), "p.condition.0.value": txt("min") });
    const s = buildSentence(f, ctx(emails, ex, f));
    expect(s.text).toBe("Take the recipe name, the cook time from emails from Gmail about “pasta” and keep only the ones where the cook time contains “min”.");
    expect(s.status).toBe("complete");
  });

  it("turns classification categories into an enum field", () => {
    const c = piece("transform", { source: ref(emails.id), operation: opt("classify"), "p.categories.0": txt("recipe"), "p.categories.1": txt("restaurant") });
    const fields = fieldsOf(c.id, ctx(emails, c)).fields;
    expect(fields.find((f) => f.id === "category")).toEqual({ id: "category", label: "category", type: "enum", values: ["recipe", "restaurant"] });
  });

  it("keeps only picked fields", () => {
    const t = piece("transform", { source: ref(emails.id), operation: opt("pick_fields"), "p.fields.0": opt("subject"), "p.fields.1": opt("from") });
    expect(fieldsOf(t.id, ctx(emails, t)).fields.map((f) => f.id)).toEqual(["from", "subject"]);
  });

  it("never offers a piece that already depends on this one", () => {
    const t1 = piece("transform", { source: ref(emails.id), operation: opt("dedupe") });
    const t2 = piece("transform", { source: ref(t1.id), operation: opt("sort"), "p.field": opt("date"), "p.direction": opt("newest first") });
    const s1 = buildSentence(t1, ctx(emails, t1, t2));
    const src = s1.tokens.find((x) => x.type === "slot" && x.spec.id === "source");
    const offered = src && src.type === "slot" ? src.spec.options.map((o) => o.pieceId) : [];
    expect(offered).toEqual([emails.id]);
    const s2 = buildSentence(t2, ctx(emails, t1, t2));
    expect(s2.text).toBe("Take emails from Gmail about “pasta” without duplicates and sort them by date received newest first.");
  });

  it("combines two pieces and exposes both field sets", () => {
    const contacts = piece("input", { integration: opt("gmail"), object: opt("contacts"), "filter.0.field": opt("group"), "filter.0.op": opt("is"), "filter.0.value": txt("Friends") });
    const t = piece("transform", { source: ref(emails.id), operation: opt("combine"), "p.other": ref(contacts.id), "p.field": opt("from"), "p.other_field": txt("email address") });
    const s = buildSentence(t, ctx(emails, contacts, t));
    expect(s.text).toBe("Take emails from Gmail about “pasta” and combine with contacts from Gmail about “Friends” matching sender to “email address”.");
    expect(fieldsOf(t.id, ctx(emails, contacts, t)).fields.map((f) => f.id)).toContain("group");
  });
});

describe("expected outputs", () => {
  const emails = piece("input", { integration: opt("gmail"), object: opt("emails"), "filter.0.field": opt("__all__") });
  const friends = piece("input", { integration: opt("gmail"), object: opt("contacts"), "filter.0.field": opt("group"), "filter.0.op": opt("is"), "filter.0.value": txt("Friends") });
  const summaries = piece("transform", { source: ref(emails.id), operation: opt("summarize"), "p.length": opt("in one line") });

  it("starts with the destination", () => {
    const o = piece("output");
    expect(buildSentence(o, ctx(o)).text).toBe("To [somewhere]");
  });

  it("uses the send pattern with a referenced recipient list", () => {
    const o = piece("output", { integration: opt("gmail"), action: opt("send_email"), source: ref(summaries.id), "p.to": ref(friends.id) });
    const s = buildSentence(o, ctx(emails, friends, summaries, o));
    expect(s.text).toBe("Send summaries of all emails from Gmail to Gmail as an email to each person in contacts from Gmail about “Friends”.");
    expect(s.status).toBe("complete");
    expect(s.refs.sort()).toEqual([friends.id, summaries.id].sort());
    expect(s.label).toBe("an email via Gmail");
  });

  it("uses the create pattern for records", () => {
    const o = piece("output", { integration: opt("monday"), action: opt("create_item"), source: ref(summaries.id), "p.board": txt("Roadmap") });
    const s = buildSentence(o, ctx(emails, summaries, o));
    expect(s.text).toBe("Create an item in Monday.com from summaries of all emails from Gmail on the board “Roadmap”.");
    expect(s.status).toBe("complete");
  });

  it("adds an acceptance check once settled", () => {
    const o = piece("output", { integration: opt("report"), action: opt("answer"), source: ref(summaries.id), outcome: txt("I see one line per email") });
    const s = buildSentence(o, ctx(emails, summaries, o));
    expect(s.text).toBe("Show summaries of all emails from Gmail to A document for me as an answer on screen, and I’ll know it worked when “I see one line per email”.");
  });
});

describe("plan analysis and handoff", () => {
  it("flags unused pieces and reports readiness", () => {
    const emails = piece("input", { integration: opt("gmail"), object: opt("emails"), "filter.0.field": opt("__all__") });
    const stray = piece("input", { integration: opt("gmail"), object: opt("labels"), "filter.0.field": opt("__all__") });
    const out = piece("output", { integration: opt("report"), action: opt("answer"), source: ref(emails.id) });
    const a = analyzePlan([emails, stray, out], catalog);
    expect(a.edges).toEqual([{ from: emails.id, to: out.id }]);
    expect(a.nudges.some((n) => n.id === `unused:${stray.id}` && n.level === "warn")).toBe(true);
    expect(a.ready).toBe(false);
    const b = analyzePlan([emails, out], catalog);
    expect(b.ready).toBe(true);
    expect(b.nudges.find((n) => n.id === "ready")?.level).toBe("done");
  });

  it("renders a numbered markdown handoff", () => {
    const emails = piece("input", { integration: opt("gmail"), object: opt("emails"), "filter.0.field": opt("__all__") }, { notes: "Only my own inbox." });
    const sum = piece("transform", { source: ref(emails.id), operation: opt("summarize"), "p.length": opt("in one line") });
    const out = piece("output", { integration: opt("report"), action: opt("document"), source: ref(sum.id), "p.format": opt("a PDF"), "p.delivery": opt("by email to me") });
    const doc = buildHandoff({ id: "plan", title: "Pasta digest", thought: "email me my pasta emails", facts: ["Pasta means recipes"], status: "draft" }, [emails, sum, out], catalog, {
      orgGuidance: "Prefer Claude Routines over n8n.",
      preferredBuilder: "Claude Routines",
      generatedAt: new Date("2026-09-01T00:00:00Z"),
    });
    expect(doc.pieces.map((p) => p.number)).toEqual(["Input 1", "Transformation 1", "Expected output 1"]);
    expect(doc.pieces[2]!.dependsOn).toEqual(["Transformation 1"]);
    const md = renderHandoffMarkdown(doc);
    expect(md).toContain("# Pasta digest");
    expect(md).toContain("- Pasta means recipes");
    expect(md).toContain("### Input 1 · all emails from Gmail");
    expect(md).toContain("Notes: Only my own inbox.");
    expect(md).toContain("### Transformation 1 · summaries of all emails from Gmail · AI step");
    expect(md).toContain("Preferred builder: Claude Routines");
    expect(md).toContain("**Gmail**");
  });
});

describe("manifest validation", () => {
  it("rejects an integration without roles or objects", () => {
    const r = safeParseManifest({ id: "x", name: "X", version: "1", description: "d", kind: "integration", roles: ["input"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("\n")).toContain("objects");
  });

  it("rejects enum fields without values", () => {
    const r = safeParseManifest({
      id: "x",
      name: "X",
      version: "1",
      description: "d",
      roles: ["input"],
      objects: [{ id: "things", label: "things", singular: "thing", fields: [{ id: "state", label: "state", type: "enum" }] }],
    });
    expect(r.ok).toBe(false);
  });
});

describe("robustness", () => {
  const emails = piece("input", { integration: opt("gmail"), object: opt("emails"), "filter.0.field": opt("__all__") });

  it("handles two independent transformations without recursing forever", () => {
    const t1 = piece("transform", { source: ref(emails.id), operation: opt("dedupe") });
    const t2 = piece("transform", { source: ref(emails.id), operation: opt("sort"), "p.field": opt("date"), "p.direction": opt("newest first") });
    const t3 = piece("transform", { source: ref(t2.id), operation: opt("top"), "p.n": txt("5") });
    const a = analyzePlan([emails, t1, t2, t3], catalog);
    expect(a.sentences[t1.id]!.status).toBe("complete");
    expect(a.sentences[t3.id]!.label).toBe("the top 5 of all emails from Gmail sorted by date received");
    const src = a.sentences[t1.id]!.tokens.find((t) => t.type === "slot" && t.spec.id === "source");
    const offered = src && src.type === "slot" ? src.spec.options : [];
    expect(offered.map((o) => o.pieceId).sort()).toEqual([emails.id, t2.id, t3.id].sort());
    expect(offered.find((o) => o.pieceId === t2.id)?.label).toBe("all emails from Gmail sorted by date received");
  });

  it("keeps optional values while a required blank is being changed", () => {
    const p = piece("input", {
      integration: opt("gmail"),
      object: opt("emails"),
      "filter.0.field": opt("subject"),
      "filter.0.op": opt("contains"),
      "filter.0.value": txt("pasta"),
      timeRange: opt("30d"),
      trigger: opt("daily"),
    });
    const unsettled = withSlot(p, "filter.0.op", undefined);
    const { piece: cleaned, sentence } = cleanPiece(unsettled, ctx(unsettled));
    expect(cleaned.slots.trigger).toEqual(opt("daily"));
    expect(cleaned.slots.timeRange).toEqual(opt("30d"));
    expect(sentence.text).toContain("[is…]");
    expect(sentence.text).toContain("every morning");
    const optionalTokens = sentence.tokens.filter((t) => t.type === "slot" && t.spec.optional && !t.value);
    expect(optionalTokens).toHaveLength(0);
  });

  it("derives fields through a diamond", () => {
    const t1 = piece("transform", { source: ref(emails.id), operation: opt("dedupe") });
    const t2 = piece("transform", { source: ref(emails.id), operation: opt("pick_fields"), "p.fields.0": opt("subject") });
    const t3 = piece("transform", { source: ref(t1.id), operation: opt("combine"), "p.other": ref(t2.id), "p.field": opt("from"), "p.other_field": txt("subject") });
    const ids = fieldsOf(t3.id, ctx(emails, t1, t2, t3)).fields.map((f) => f.id);
    expect(ids).toContain("from");
    expect(ids).toContain("subject");
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("does not duplicate extracted or existing field ids", () => {
    const ex = piece("transform", { source: ref(emails.id), operation: opt("extract"), "p.items.0": txt("subject"), "p.items.1": txt("the subject"), "p.items.2": txt("subject") });
    const ids = fieldsOf(ex.id, ctx(emails, ex)).fields.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((i) => i === "subject")).toHaveLength(1);
  });

  it("keeps dollar signs in custom labels and typed values", () => {
    const named = piece("input", { integration: opt("gmail"), object: opt("emails"), "filter.0.field": opt("__all__") }, { label: "$& budget $' items" });
    const t = piece("transform", { source: ref(named.id), operation: opt("dedupe") });
    const s = buildSentence(t, ctx(named, t));
    expect(s.text).toBe("Take $& budget $' items and remove duplicates.");
    const typed = piece("input", { integration: opt("gmail"), object: opt("emails"), "filter.0.field": opt("subject"), "filter.0.op": opt("contains"), "filter.0.value": txt("hello , world .") });
    expect(tokensToText(buildSentence(typed, ctx(typed)).tokens)).toContain("“hello , world .”");
  });
});
