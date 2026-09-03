import { buildSentence, cleanPiece, type Catalog, type PieceData, type SlotValue, type Token } from "@planifold/shared";
import type { SuggestedSlot } from "./schema.js";
export { SuggestedSlotSchema } from "./schema.js";

export interface ApplyResult {
  piece: PieceData;
  applied: string[];
  dropped: string[];
}

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/[“”"']/g, "");
}

/** Turns a suggested slot into a stored value, matching option labels when the id is unknown. */
function toValue(slotToken: Extract<Token, { type: "slot" }>, s: SuggestedSlot): SlotValue | undefined {
  const spec = slotToken.spec;
  if (s.type === "ref") {
    const pieceId = s.value.replace(/^ref:/, "");
    return spec.options.some((o) => o.pieceId === pieceId) ? { kind: "ref", pieceId } : undefined;
  }
  const byId = spec.options.find((o) => !o.pieceId && o.id === s.value);
  if (byId) return { kind: "option", id: byId.id };
  const n = normalize(s.value);
  const byLabel = spec.options.find((o) => !o.pieceId && normalize(o.label) === n);
  if (byLabel) return { kind: "option", id: byLabel.id };
  const refByLabel = spec.options.find((o) => o.pieceId && normalize(o.label) === n);
  if (refByLabel) return { kind: "ref", pieceId: refByLabel.pieceId! };
  // Only values the model explicitly typed become free text; an unknown option id is a mistake, not a phrase.
  if (s.type === "text" && spec.allowText && s.value.trim()) return { kind: "text", text: s.value.trim().slice(0, 2000) };
  return undefined;
}

/**
 * Applies suggested slot values in whatever order the grammar reaches them.
 * Values the grammar never reaches, or that don't fit, are reported as dropped.
 */
export function applySuggestion(catalog: Catalog, pieces: PieceData[], target: PieceData, slots: SuggestedSlot[]): ApplyResult {
  const pending = new Map<string, SuggestedSlot>();
  for (const s of slots) pending.set(s.id, s);
  let current: PieceData = { ...target, slots: { ...target.slots } };
  const applied: string[] = [];
  const dropped: string[] = [];
  const others = pieces.filter((p) => p.id !== target.id);

  for (let guard = 0; guard < 80 && pending.size; guard++) {
    const ctx = { catalog, pieces: [...others, current] };
    const sentence = buildSentence(current, ctx);
    let progressed = false;
    for (const t of sentence.tokens) {
      if (t.type !== "slot") continue;
      const s = pending.get(t.spec.id);
      if (!s) continue;
      pending.delete(t.spec.id);
      const value = toValue(t, s);
      if (value) {
        current = { ...current, slots: { ...current.slots, [t.spec.id]: value } };
        applied.push(t.spec.id);
      } else dropped.push(t.spec.id);
      progressed = true;
      break; // Re-run the grammar: this fill may open new slots.
    }
    if (!progressed) break;
  }
  for (const id of pending.keys()) dropped.push(id);
  const cleaned = cleanPiece(current, { catalog, pieces: [...others, current] });
  return { piece: cleaned.piece, applied, dropped };
}
