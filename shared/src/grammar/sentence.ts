import type { PieceData, Sentence, SlotValue } from "../types.js";
import { tokensToText } from "../text.js";
import { Builder } from "./builder.js";
import type { GrammarContext } from "./context.js";
import { buildInput } from "./input.js";
import { buildOutput } from "./output.js";
import { buildTransform } from "./transform.js";

const KIND_FALLBACK: Record<PieceData["kind"], string> = { input: "this input", transform: "this transformation", output: "this output" };

/** What a piece looks like from inside its own build: enough to name it, nothing more. */
function placeholderSentence(piece: PieceData): Sentence {
  const label = piece.label?.trim() || KIND_FALLBACK[piece.kind];
  return { tokens: [], status: "empty", label, autoLabel: label, text: "", missing: [], unsure: [], refs: [], visited: [], invalid: [], ai: false };
}

/** Builds a piece far enough to know its label and text, without listing its siblings. */
export function summarize(piece: PieceData, ctx: GrammarContext): Sentence {
  if (ctx.lite) return buildSentence(piece, ctx);
  ctx.liteCache ??= new Map();
  ctx.building ??= new Set();
  return buildSentence(piece, { catalog: ctx.catalog, pieces: ctx.pieces, lite: true, cache: ctx.liteCache, liteCache: ctx.liteCache, building: ctx.building });
}

/** Builds the sentence for one piece. Pure; safe to call on every render. */
export function buildSentence(piece: PieceData, ctx: GrammarContext): Sentence {
  const cached = ctx.cache?.get(piece.id);
  if (cached) return cached;
  ctx.building ??= new Set();
  if (ctx.building.has(piece.id)) return placeholderSentence(piece);
  ctx.building.add(piece.id);
  try {
    const b = new Builder(piece, ctx);
    const autoLabel = piece.kind === "input" ? buildInput(b) : piece.kind === "transform" ? buildTransform(b) : buildOutput(b);
    const status = b.missing.length === 0 ? "complete" : b.anyValue ? "partial" : "empty";
    const sentence: Sentence = {
      tokens: b.tokens,
      status,
      autoLabel,
      label: piece.label?.trim() || autoLabel,
      text: tokensToText(b.tokens),
      missing: b.missing,
      unsure: b.unsure,
      refs: [...b.refs],
      visited: b.visited,
      invalid: b.invalid,
      ai: b.ai,
    };
    ctx.cache?.set(piece.id, sentence);
    return sentence;
  } finally {
    ctx.building.delete(piece.id);
  }
}

/** Returns a copy of the piece with one slot changed (or cleared with undefined). */
export function withSlot(piece: PieceData, slotId: string, value: SlotValue | undefined): PieceData {
  const slots = { ...piece.slots };
  if (value === undefined) delete slots[slotId];
  else slots[slotId] = value;
  return { ...piece, slots };
}

/**
 * Drops slot values the grammar no longer reaches or accepts, so a piece never
 * carries stale state from an earlier choice. Runs the grammar twice because
 * removing one value can change what is reachable.
 */
export function cleanPiece(piece: PieceData, ctx: GrammarContext): { piece: PieceData; sentence: Sentence } {
  let current = piece;
  for (let pass = 0; pass < 3; pass++) {
    const local: GrammarContext = { catalog: ctx.catalog, pieces: ctx.pieces.map((p) => (p.id === current.id ? current : p)) };
    const s = buildSentence(current, local);
    const keep = new Set(s.visited.filter((id) => !s.invalid.includes(id)));
    const slots: PieceData["slots"] = {};
    for (const [k, v] of Object.entries(current.slots)) if (keep.has(k)) slots[k] = v;
    const changed = Object.keys(slots).length !== Object.keys(current.slots).length;
    current = { ...current, slots };
    if (!changed) return { piece: current, sentence: s };
  }
  const local: GrammarContext = { catalog: ctx.catalog, pieces: ctx.pieces.map((p) => (p.id === current.id ? current : p)) };
  return { piece: current, sentence: buildSentence(current, local) };
}
