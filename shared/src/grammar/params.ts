import type { Param } from "../manifest.js";
import type { SlotSpec } from "../types.js";
import type { Builder, Resolved } from "./builder.js";
import { conditionClauses } from "./conditions.js";
import type { FieldSet } from "./fields.js";
import { refOptions } from "./refs.js";

export interface ParamEnv {
  fields: FieldSet;
  /** Piece ids that must not be offered as references (the source itself). */
  excludeRefs?: string[];
}

const textType = (t: Param["type"]) => (t === "number" ? "number" : t === "date" ? "date" : "text");

/** Emits the params of an operation or action, in order. */
export function emitParams(b: Builder, params: Param[], env: ParamEnv): void {
  for (const p of params) {
    const base = `p.${p.id}`;
    switch (p.type) {
      case "text":
      case "number":
      case "date":
      case "enum":
      case "field":
      case "ref":
      case "ref-or-text": {
        const spec = singleSpec(b, base, p, env);
        emitSingle(b, p, spec);
        break;
      }
      case "fields":
      case "texts": {
        emitList(b, p, base, env);
        break;
      }
      case "condition": {
        if (p.label) b.text(p.label);
        conditionClauses(b, base, env.fields.fields, { allowCustom: env.fields.allowCustom });
        break;
      }
    }
  }
}

function singleSpec(b: Builder, id: string, p: Param, env: ParamEnv): SlotSpec {
  const placeholder = p.placeholder ?? "…";
  switch (p.type) {
    case "enum":
      return { id, placeholder, options: (p.values ?? []).map((v) => ({ id: v, label: v })), optional: p.optional, help: p.description };
    case "field":
      return {
        id,
        placeholder,
        options: env.fields.fields.map((f) => ({ id: f.id, label: f.label, description: f.description })),
        allowText: env.fields.allowCustom,
        textHint: "field or column name",
        optional: p.optional,
        help: p.description,
      };
    case "ref":
      return { id, placeholder, options: refOptions(b, { exclude: env.excludeRefs, refLabel: p.refLabel }), optional: p.optional, help: p.description };
    case "ref-or-text":
      return {
        id,
        placeholder,
        options: refOptions(b, { exclude: env.excludeRefs, refLabel: p.refLabel }),
        allowText: true,
        textHint: p.placeholder,
        optional: p.optional,
        help: p.description,
      };
    default:
      return { id, placeholder, options: [], allowText: true, textType: textType(p.type), textHint: p.placeholder, optional: p.optional, help: p.description };
  }
}

function emitSingle(b: Builder, p: Param, spec: SlotSpec): Resolved | undefined {
  const r = b.resolve(spec);
  if (!r.value && spec.optional) {
    // Optional and empty: show a quiet "+ label" blank, only once the rest is settled.
    if (!b.settled) return r;
    b.emit({ ...r, spec: { ...spec, placeholder: p.label || spec.placeholder } });
    return r;
  }
  if (p.label) b.text(p.label);
  b.emit(r);
  if (r.filled && p.suffix) b.text(p.suffix);
  return r;
}

function emitList(b: Builder, p: Param, base: string, env: ParamEnv): void {
  const isFields = p.type === "fields";
  for (let i = 0; i < 12; i++) {
    const optional = i > 0 || !!p.optional;
    const spec: SlotSpec = isFields
      ? {
          id: `${base}.${i}`,
          placeholder: i === 0 ? (p.placeholder ?? "which?") : "and…",
          options: env.fields.fields.map((f) => ({ id: f.id, label: f.label, description: f.description })),
          allowText: env.fields.allowCustom,
          textHint: "field or column name",
          optional,
          help: p.description,
        }
      : {
          id: `${base}.${i}`,
          placeholder: i === 0 ? (p.placeholder ?? "…") : "and…",
          options: [],
          allowText: true,
          textHint: p.placeholder,
          optional,
          help: p.description,
        };
    const r = b.resolve(spec);
    if (i === 0) {
      if (!r.value && optional) {
        if (b.settled) b.emit({ ...r, spec: { ...spec, placeholder: p.label || spec.placeholder } });
        return;
      }
      if (p.label) b.text(p.label);
    } else if (r.filled) b.text("and");
    b.emit(r);
    if (!r.filled) {
      if (i > 0 && p.suffix) b.text(p.suffix);
      return;
    }
  }
  if (p.suffix) b.text(p.suffix);
}
