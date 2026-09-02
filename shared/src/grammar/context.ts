import type { Catalog } from "../catalog.js";
import type { PieceData, Sentence } from "../types.js";

export interface GrammarContext {
  catalog: Catalog;
  pieces: PieceData[];
  /** Per-render memo of built sentences. Create a fresh context per render. */
  cache?: Map<string, Sentence>;
  /** Pieces currently being built; guards against cyclic data. */
  building?: Set<string>;
  /**
   * Lite mode builds a piece only far enough to know its label and text:
   * reference menus list just the pieces it already points at, so summarizing
   * a candidate never fans out to its siblings.
   */
  lite?: boolean;
  liteCache?: Map<string, Sentence>;
}

export function pieceById(ctx: GrammarContext, id: string | undefined): PieceData | undefined {
  return id ? ctx.pieces.find((p) => p.id === id) : undefined;
}

export function optionId(piece: PieceData, slotId: string): string | undefined {
  const v = piece.slots[slotId];
  return v && v.kind === "option" ? v.id : undefined;
}

export function refId(piece: PieceData, slotId: string): string | undefined {
  const v = piece.slots[slotId];
  return v && v.kind === "ref" ? v.pieceId : undefined;
}

export function textOf(piece: PieceData, slotId: string): string | undefined {
  const v = piece.slots[slotId];
  return v && v.kind === "text" ? v.text : undefined;
}

/** Values of a repeated slot: prefix.0, prefix.1, ... until the first gap. */
export function listValues(piece: PieceData, prefix: string): Array<{ slotId: string; text?: string; optionId?: string }> {
  const out: Array<{ slotId: string; text?: string; optionId?: string }> = [];
  for (let i = 0; i < 20; i++) {
    const id = `${prefix}.${i}`;
    const v = piece.slots[id];
    if (!v || v.kind === "unsure" || v.kind === "ref") break;
    out.push(v.kind === "text" ? { slotId: id, text: v.text } : { slotId: id, optionId: v.id });
  }
  return out;
}
