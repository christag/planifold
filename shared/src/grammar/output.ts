import { findIntegration } from "../catalog.js";
import type { Builder } from "./builder.js";
import { fieldsOf } from "./fields.js";
import { emitParams } from "./params.js";
import { refOptions } from "./refs.js";

/**
 * Expected output:  To [somewhere]
 *                   Send [what] to Gmail as [what kind of thing?]
 *                   Send *the summaries* to Gmail as an email to [who] ...
 *                   Create a ticket in Jira from *the summaries* in project [X]
 */
export function buildOutput(b: Builder): string {
  const catalog = b.ctx.catalog;
  const integrations = catalog.integrations.filter((i) => i.roles.includes("output"));
  const ir = b.resolve({
    id: "integration",
    placeholder: "somewhere",
    options: integrations.map((i) => ({ id: i.id, label: i.name, description: i.description, group: i.category })),
    help: "Where should the result end up?",
  });
  if (!ir.filled) {
    b.text("To");
    b.emit(ir);
    return "new output";
  }
  const integ = findIntegration(catalog, ir.id)!;

  const ar = b.resolve({
    id: "action",
    placeholder: "what kind of thing?",
    options: integ.actions.map((a) => ({ id: a.id, label: a.label, description: a.description })),
    help: `What should be created in ${integ.name}?`,
  });
  const action = ar.filled ? integ.actions.find((a) => a.id === ar.id) : undefined;
  const pattern = action?.pattern ?? "send";
  const verb = action?.verb ?? "Send";
  const sourceSpec = {
    id: "source",
    placeholder: "what?",
    options: refOptions(b),
    optional: action?.source === "optional",
    help: "Which piece is being sent?",
  };

  let sourcePieceId: string | undefined;
  if (pattern === "create") {
    b.text(verb);
    b.emit(ar);
    b.text("in");
    b.emit(ir);
    if (action?.source !== "none") {
      const sr = b.resolve(sourceSpec);
      if (sr.filled || !sr.spec.optional || b.settled) {
        b.text("from");
        b.emit(sr);
      }
      sourcePieceId = sr.refPieceId;
    }
  } else {
    b.text(verb);
    if (!action || action.source !== "none") {
      const sr = b.slot(sourceSpec);
      sourcePieceId = sr.refPieceId;
    }
    b.text("to");
    b.emit(ir);
    b.text("as");
    b.emit(ar);
  }

  if (action) {
    emitParams(b, action.params, { fields: fieldsOf(sourcePieceId, b.ctx), excludeRefs: sourcePieceId ? [sourcePieceId] : [] });
    const settled = b.settled;
    const outcome = b.resolve({
      id: "outcome",
      placeholder: "how will I know it worked?",
      options: [],
      allowText: true,
      textHint: "e.g. every friend gets exactly one email",
      optional: true,
      help: "What should be true afterwards? This becomes the acceptance check.",
    });
    if (outcome.filled) b.text(", and I’ll know it worked when");
    if (settled || outcome.value) b.emit(outcome);
  }
  if (b.settled) b.text(".");

  return action ? `${action.label} via ${integ.name}` : `something to ${integ.name}`;
}
