import type { Field, FieldType } from "../manifest.js";
import type { SlotOption, SlotSpec } from "../types.js";
import { slugify } from "../text.js";
import type { Builder, Resolved } from "./builder.js";

export type OperatorValue = "none" | "text" | "number" | "date" | "enum" | "period";

export interface OperatorDef {
  id: string;
  label: string;
  value: OperatorValue;
}

const TEXT_OPS: OperatorDef[] = [
  { id: "contains", label: "contains", value: "text" },
  { id: "not_contains", label: "does not contain", value: "text" },
  { id: "is", label: "is", value: "text" },
  { id: "is_not", label: "is not", value: "text" },
  { id: "starts_with", label: "starts with", value: "text" },
  { id: "is_empty", label: "is empty", value: "none" },
  { id: "not_empty", label: "is not empty", value: "none" },
];

const OPERATORS: Record<FieldType, OperatorDef[]> = {
  string: TEXT_OPS,
  text: TEXT_OPS,
  url: TEXT_OPS,
  person: [
    { id: "is", label: "is", value: "text" },
    { id: "is_not", label: "is not", value: "text" },
    { id: "contains", label: "contains", value: "text" },
    { id: "is_me", label: "is me", value: "none" },
  ],
  email: [
    { id: "is", label: "is", value: "text" },
    { id: "is_not", label: "is not", value: "text" },
    { id: "contains", label: "contains", value: "text" },
    { id: "is_me", label: "is me", value: "none" },
  ],
  number: [
    { id: "eq", label: "is", value: "number" },
    { id: "neq", label: "is not", value: "number" },
    { id: "gt", label: "is more than", value: "number" },
    { id: "lt", label: "is less than", value: "number" },
  ],
  date: [
    { id: "in_last", label: "is in the last", value: "period" },
    { id: "after", label: "is after", value: "date" },
    { id: "before", label: "is before", value: "date" },
    { id: "today", label: "is today", value: "none" },
    { id: "on", label: "is on", value: "date" },
  ],
  datetime: [
    { id: "in_last", label: "is in the last", value: "period" },
    { id: "after", label: "is after", value: "date" },
    { id: "before", label: "is before", value: "date" },
    { id: "today", label: "is today", value: "none" },
  ],
  boolean: [
    { id: "true", label: "is true", value: "none" },
    { id: "false", label: "is false", value: "none" },
  ],
  enum: [
    { id: "is", label: "is", value: "enum" },
    { id: "is_not", label: "is not", value: "enum" },
  ],
  attachment: [
    { id: "exists", label: "is present", value: "none" },
    { id: "not_exists", label: "is missing", value: "none" },
  ],
};

export const PERIODS: SlotOption[] = [
  { id: "24h", label: "24 hours" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "90d", label: "90 days" },
  { id: "12m", label: "12 months" },
];

export function operatorsFor(type: FieldType): OperatorDef[] {
  return OPERATORS[type] ?? TEXT_OPS;
}

export const ALL_OPTION_ID = "__all__";

export interface ConditionOptions {
  allowCustom: boolean;
  /** Word before the first clause, e.g. "where". */
  firstWord?: string;
  /** Offer "all of them" as the first choice. */
  allowAll?: boolean;
  /** Pre-resolved first field slot (lets the caller restructure the sentence). */
  first?: Resolved;
  max?: number;
}

export function fieldSpec(prefix: string, i: number, fields: Field[], opts: { allowCustom: boolean; allowAll?: boolean }): SlotSpec {
  const options: SlotOption[] = [];
  if (i === 0 && opts.allowAll) options.push({ id: ALL_OPTION_ID, label: "all", description: "No filter. Every one of them." });
  for (const f of fields) options.push({ id: f.id, label: f.label, description: f.description, group: "Fields" });
  return {
    id: `${prefix}.${i}.field`,
    placeholder: i === 0 ? "which ones?" : "and…",
    options,
    allowText: opts.allowCustom,
    textHint: "field or column name",
    optional: i > 0,
    help: i === 0 ? "Narrow it down, or choose all." : "Add another condition.",
  };
}

function fieldFor(r: Resolved, fields: Field[]): Field | undefined {
  if (r.id) return fields.find((f) => f.id === r.id);
  if (r.text) return { id: slugify(r.text), label: r.text, type: "string" };
  return undefined;
}

function valueSpec(prefix: string, i: number, field: Field, op: OperatorDef): SlotSpec | undefined {
  const id = `${prefix}.${i}.value`;
  switch (op.value) {
    case "none":
      return undefined;
    case "enum":
      return { id, placeholder: "which?", options: (field.values ?? []).map((v) => ({ id: v, label: v })) };
    case "period":
      return { id, placeholder: "how long?", options: PERIODS };
    case "date":
      return { id, placeholder: "a date", options: [], allowText: true, textType: "date", textHint: "e.g. 2026-01-31" };
    case "number":
      return { id, placeholder: "a number", options: [], allowText: true, textType: "number", textHint: "a number" };
    case "text":
      return { id, placeholder: "what?", options: [], allowText: true, textHint: "a word or phrase" };
  }
}

/**
 * Emits "field op value [and field op value ...]" clauses.
 * Returns the number of complete clauses.
 */
export function conditionClauses(b: Builder, prefix: string, fields: Field[], opts: ConditionOptions): number {
  const max = opts.max ?? 8;
  let complete = 0;
  for (let i = 0; i < max; i++) {
    const fr = i === 0 && opts.first ? opts.first : b.resolve(fieldSpec(prefix, i, fields, { allowCustom: opts.allowCustom, allowAll: opts.allowAll && i === 0 }));
    if (i === 0) {
      if (opts.firstWord) b.text(opts.firstWord);
    } else if (fr.filled) b.text("and");
    b.emit(fr);
    if (!fr.filled) break;
    const field = fieldFor(fr, fields);
    if (!field) break;
    const ops = operatorsFor(field.type);
    const opr = b.slot({
      id: `${prefix}.${i}.op`,
      placeholder: "is…",
      options: ops.map((o) => ({ id: o.id, label: o.label })),
    });
    if (!opr.filled) break;
    const op = ops.find((o) => o.id === opr.id);
    if (!op) break;
    const vs = valueSpec(prefix, i, field, op);
    if (vs) {
      const vr = b.slot(vs);
      if (!vr.filled) break;
    }
    complete++;
  }
  return complete;
}
