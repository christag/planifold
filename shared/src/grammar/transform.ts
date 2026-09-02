import { findOperation, type CatalogOperation } from "../catalog.js";
import type { Field } from "../manifest.js";
import type { Builder } from "./builder.js";
import { listValues, optionId, refId, textOf } from "./context.js";
import { fieldsOf } from "./fields.js";
import { emitParams } from "./params.js";
import { labelOf, refOptions } from "./refs.js";

/**
 * Transformation:  Take [a piece]
 *                  Take *the emails* and [do what?]
 *                  Take *the emails* and summarize each one [in one line].
 */
export function buildTransform(b: Builder): string {
  const catalog = b.ctx.catalog;
  const sr = b.resolve({
    id: "source",
    placeholder: "a piece",
    options: refOptions(b),
    help: "Which piece does this work on?",
  });
  b.text("Take");
  b.emit(sr);
  if (!sr.filled) return "new transformation";
  const sourceLabel = labelOf(sr.refPieceId!, b.ctx);

  b.text("and");
  const opr = b.slot({
    id: "operation",
    placeholder: "do what?",
    options: catalog.operations.map((o) => ({ id: o.id, label: o.label, description: o.description, group: o.category ?? "Other" })),
    help: "What should happen to it?",
  });
  const op = findOperation(catalog, opr.id);
  if (!op) {
    return `something from ${sourceLabel}`;
  }
  if (op.ai) b.ai = true;
  const fields = fieldsOf(sr.refPieceId, b.ctx);
  emitParams(b, op.params, { fields, excludeRefs: [sr.refPieceId!] });
  if (b.settled) b.text(".");

  return fillTemplate(op.result.label, b, sourceLabel, op.params, fields.fields);
}

function fillTemplate(template: string, b: Builder, sourceLabel: string, params: CatalogOperation["params"], fields: Field[]): string {
  const fieldLabel = (id: string) => fields.find((f) => f.id === id)?.label ?? id;
  return template.replace(/\{([a-z0-9_]+)\}/g, (_m, key: string) => {
    if (key === "source") return sourceLabel;
    const piece = b.piece;
    const param = params.find((p) => p.id === key);
    const ref = refId(piece, `p.${key}`);
    if (ref) return labelOf(ref, b.ctx);
    const single = textOf(piece, `p.${key}`) ?? optionId(piece, `p.${key}`);
    if (single) return param?.type === "field" ? fieldLabel(single) : single;
    const list = listValues(piece, `p.${key}`)
      .map((v) => v.text ?? (v.optionId ? (param?.type === "fields" ? fieldLabel(v.optionId) : v.optionId) : undefined))
      .filter(Boolean);
    if (list.length) return list.join(", ");
    return "…";
  });
}
