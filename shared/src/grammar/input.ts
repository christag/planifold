import { findIntegration } from "../catalog.js";
import type { SlotOption } from "../types.js";
import type { Builder } from "./builder.js";
import { ALL_OPTION_ID, conditionClauses, fieldSpec } from "./conditions.js";
import { optionId, textOf } from "./context.js";

export const TIME_RANGE_OPTIONS: SlotOption[] = [
  { id: "any", label: "from any time" },
  { id: "24h", label: "from the last 24 hours" },
  { id: "7d", label: "from the last 7 days" },
  { id: "30d", label: "from the last 30 days" },
  { id: "90d", label: "from the last 90 days" },
  { id: "year", label: "from this year" },
];

export const TRIGGER_OPTIONS: SlotOption[] = [
  { id: "manual", label: "once, when I run it", description: "A one-off. Someone starts it by hand." },
  { id: "new", label: "whenever a new one appears", description: "Event-driven. Runs as things arrive." },
  { id: "hourly", label: "every hour" },
  { id: "daily", label: "every morning" },
  { id: "weekdays", label: "every weekday morning" },
  { id: "weekly", label: "every Monday" },
  { id: "monthly", label: "on the first of each month" },
];

/**
 * Input:  From [somewhere]
 *         I want to get [what] from Gmail
 *         I want to get emails from Gmail where [which ones?] ...
 */
export function buildInput(b: Builder): string {
  const catalog = b.ctx.catalog;
  const integrations = catalog.integrations.filter((i) => i.roles.includes("input"));
  const ir = b.resolve({
    id: "integration",
    placeholder: "somewhere",
    options: integrations.map((i) => ({ id: i.id, label: i.name, description: i.description, group: i.category })),
    help: "Where does this information live today?",
  });
  if (!ir.filled) {
    b.text("From");
    b.emit(ir);
    return "new input";
  }
  const integ = findIntegration(catalog, ir.id)!;

  const or = b.resolve({
    id: "object",
    placeholder: "what?",
    options: integ.objects.map((o) => ({ id: o.id, label: o.label, description: o.description })),
    help: `What do you want out of ${integ.name}?`,
  });
  const obj = or.filled ? integ.objects.find((o) => o.id === or.id) : undefined;
  const filterable = !!obj && obj.filterable && (obj.fields.length > 0 || obj.allowCustomFields);
  const first = obj && filterable ? b.resolve(fieldSpec("filter", 0, obj.fields, { allowCustom: obj.allowCustomFields, allowAll: true })) : undefined;
  const all = first?.id === ALL_OPTION_ID;

  b.text("I want to get");
  if (first && all) b.emit(first);
  b.emit(or);
  b.text("from");
  b.emit(ir);

  if (obj?.qualifier) {
    b.text(obj.qualifier.label);
    b.slot({
      id: "qualifier",
      placeholder: obj.qualifier.placeholder,
      options: (obj.qualifier.values ?? []).map((v) => ({ id: v, label: v })),
      allowText: true,
      textHint: obj.qualifier.placeholder,
    });
  }

  if (obj && filterable && first && !all) {
    conditionClauses(b, "filter", obj.fields, { allowCustom: obj.allowCustomFields, firstWord: "where", first });
  }

  // Optional details are always resolved (so a stored value survives an
  // unsettled moment) but only shown once the required blanks are filled.
  if (obj) {
    const settled = b.settled;
    if (obj.timeField) {
      const range = b.resolve({
        id: "timeRange",
        placeholder: "how far back?",
        options: TIME_RANGE_OPTIONS,
        allowText: true,
        textType: "date",
        textPrefix: "since",
        textHint: "a date, e.g. 2026-01-01",
        optional: true,
        help: "How far back should this look?",
      });
      if (settled || range.value) b.emit(range);
    }
    const tr = b.resolve({
      id: "trigger",
      placeholder: "when should this run?",
      options: TRIGGER_OPTIONS,
      allowText: true,
      textHint: "describe the schedule",
      optional: true,
      help: "When should this run? Builders need to know.",
    });
    if (tr.filled) b.text(",");
    if (settled || tr.value) b.emit(tr);
  }
  if (b.settled) b.text(".");

  // Automatic label.
  if (!obj) return `${integ.name} data`;
  let label = `${all ? "all " : ""}${obj.label} from ${integ.name}`;
  const q = textOf(b.piece, "qualifier") ?? optionId(b.piece, "qualifier");
  if (q) label = `${obj.label} from ${q}`;
  const op = optionId(b.piece, "filter.0.op");
  const v = textOf(b.piece, "filter.0.value") ?? optionId(b.piece, "filter.0.value");
  if (!all && v && (op === "contains" || op === "is")) label += ` about “${v}”`;
  return label;
}
