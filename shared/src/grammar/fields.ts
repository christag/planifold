import { findIntegration, findOperation } from "../catalog.js";
import type { Field } from "../manifest.js";
import { slugify } from "../text.js";
import type { GrammarContext } from "./context.js";
import { listValues, optionId, pieceById, refId } from "./context.js";

export interface FieldSet {
  fields: Field[];
  allowCustom: boolean;
}

const EMPTY: FieldSet = { fields: [], allowCustom: true };

function addField(fields: Field[], f: Field): void {
  const i = fields.findIndex((x) => x.id === f.id);
  if (i === -1) fields.push(f);
  else fields[i] = f;
}

/**
 * The fields available on the result of a piece, following references.
 * `path` holds the pieces on the current chain only, so a piece reached
 * through two branches (a diamond) is not mistaken for a cycle.
 */
export function fieldsOf(pieceId: string | undefined, ctx: GrammarContext, path: Set<string> = new Set()): FieldSet {
  const piece = pieceById(ctx, pieceId);
  if (!piece || path.has(piece.id)) return EMPTY;
  const seen = new Set(path);
  seen.add(piece.id);

  if (piece.kind === "input") {
    const integ = findIntegration(ctx.catalog, optionId(piece, "integration"));
    const obj = integ?.objects.find((o) => o.id === optionId(piece, "object"));
    if (!obj) return EMPTY;
    return { fields: obj.fields, allowCustom: obj.allowCustomFields };
  }

  if (piece.kind === "transform") {
    const base = fieldsOf(refId(piece, "source"), ctx, seen);
    const op = findOperation(ctx.catalog, optionId(piece, "operation"));
    if (!op) return base;
    const rf = op.result.fields ?? { mode: "same" as const };
    let fields: Field[];
    let allowCustom = base.allowCustom;
    switch (rf.mode) {
      case "same":
        fields = [...base.fields];
        break;
      case "none":
        fields = [];
        allowCustom = false;
        break;
      case "replace":
        fields = [...(rf.fields ?? [])];
        allowCustom = false;
        break;
      case "extend":
        fields = [...base.fields];
        for (const f of rf.fields ?? []) addField(fields, f);
        break;
    }
    if (rf.fromParam) {
      for (const v of listValues(piece, `p.${rf.fromParam}`)) {
        const label = v.text ?? v.optionId;
        if (label && !fields.some((f) => f.id === slugify(label))) fields.push({ id: slugify(label), label, type: "string" });
      }
    }
    if (rf.enumFromParam) {
      const values = [...new Set(listValues(piece, `p.${rf.enumFromParam.param}`).map((v) => v.text ?? v.optionId).filter((v): v is string => !!v))];
      if (values.length) addField(fields, { id: rf.enumFromParam.fieldId, label: rf.enumFromParam.label, type: "enum", values });
    }
    if (rf.pickFromParam) {
      const chosen = new Set(listValues(piece, `p.${rf.pickFromParam}`).map((v) => v.optionId ?? (v.text ? slugify(v.text) : "")));
      if (chosen.size) {
        const picked = fields.filter((f) => chosen.has(f.id));
        for (const v of listValues(piece, `p.${rf.pickFromParam}`)) if (v.text && !picked.some((f) => f.id === slugify(v.text!))) picked.push({ id: slugify(v.text), label: v.text, type: "string" });
        fields = picked;
        allowCustom = false;
      }
    }
    if (rf.withRef) {
      const other = fieldsOf(refId(piece, `p.${rf.withRef}`), ctx, seen);
      for (const f of other.fields) if (!fields.some((x) => x.id === f.id)) fields.push(f);
      allowCustom = allowCustom || other.allowCustom;
    }
    const unique: Field[] = [];
    for (const f of fields) if (!unique.some((x) => x.id === f.id)) unique.push(f);
    fields = unique;
    return { fields, allowCustom };
  }

  return { fields: [], allowCustom: false };
}
