import { PIECE_KIND_LABEL, type PieceData, type SlotOption } from "../types.js";
import { truncate } from "../text.js";
import type { Builder } from "./builder.js";
import type { GrammarContext } from "./context.js";
import { summarize } from "./sentence.js";

export function directRefs(piece: PieceData): string[] {
  const out: string[] = [];
  for (const v of Object.values(piece.slots)) if (v.kind === "ref" && !out.includes(v.pieceId)) out.push(v.pieceId);
  return out;
}

/** Every piece that, directly or through other pieces, reads from `pieceId`. */
export function descendantsOf(pieceId: string, ctx: GrammarContext): Set<string> {
  const dependents = new Map<string, string[]>();
  for (const p of ctx.pieces) for (const r of directRefs(p)) dependents.set(r, [...(dependents.get(r) ?? []), p.id]);
  const seen = new Set<string>();
  const queue = [pieceId];
  while (queue.length) {
    const id = queue.shift()!;
    for (const d of dependents.get(id) ?? []) if (!seen.has(d)) {
      seen.add(d);
      queue.push(d);
    }
  }
  return seen;
}

export function labelOf(pieceId: string, ctx: GrammarContext): string {
  const piece = ctx.pieces.find((p) => p.id === pieceId);
  if (!piece) return "a missing piece";
  return summarize(piece, ctx).label;
}

/**
 * Pieces the current piece may read from: inputs and transforms that don't
 * already depend on it. In lite mode only the pieces it already points at are
 * listed, which keeps summarizing a candidate from fanning out to its siblings.
 */
export function refOptions(b: Builder, opts: { exclude?: string[]; refLabel?: string } = {}): SlotOption[] {
  const self = b.piece.id;
  const exclude = new Set(opts.exclude ?? []);
  const template = opts.refLabel ?? "{piece}";
  let candidates = b.ctx.pieces.filter((p) => p.id !== self && p.kind !== "output" && !exclude.has(p.id));
  if (b.ctx.lite) {
    const mine = new Set(directRefs(b.piece));
    candidates = candidates.filter((p) => mine.has(p.id));
  } else {
    const blocked = descendantsOf(self, b.ctx);
    candidates = candidates.filter((p) => !blocked.has(p.id));
  }
  return candidates
    .sort((a, b2) => a.position - b2.position)
    .map((p) => {
      const s = summarize(p, b.ctx);
      return {
        id: `ref:${p.id}`,
        pieceId: p.id,
        label: template.split("{piece}").join(s.label),
        description: truncate(s.text, 90),
        group: PIECE_KIND_LABEL[p.kind].plural,
      };
    });
}
