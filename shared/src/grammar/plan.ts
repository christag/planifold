import type { Catalog } from "../catalog.js";
import { findOperation } from "../catalog.js";
import { PIECE_KIND_LABEL, type Nudge, type PieceData, type PieceKind, type PlanAnalysis, type Sentence } from "../types.js";
import { optionId, textOf } from "./context.js";
import { buildSentence } from "./sentence.js";

/** Builds every sentence once and derives graph, loose ends, and nudges. */
export function analyzePlan(pieces: PieceData[], catalog: Catalog): PlanAnalysis {
  const ctx = { catalog, pieces, cache: new Map<string, Sentence>() };
  const sentences: Record<string, Sentence> = {};
  const ordered = [...pieces].sort((a, b) => a.position - b.position);
  for (const p of ordered) sentences[p.id] = buildSentence(p, ctx);

  const edges: PlanAnalysis["edges"] = [];
  for (const p of ordered) for (const r of sentences[p.id]!.refs) edges.push({ from: r, to: p.id });

  const looseEnds: PlanAnalysis["looseEnds"] = [];
  for (const p of ordered) for (const u of sentences[p.id]!.unsure) looseEnds.push({ ...u, pieceId: p.id, pieceLabel: sentences[p.id]!.label });

  const counts: PlanAnalysis["counts"] = {
    input: { total: 0, complete: 0 },
    transform: { total: 0, complete: 0 },
    output: { total: 0, complete: 0 },
  };
  for (const p of ordered) {
    counts[p.kind].total++;
    if (sentences[p.id]!.status === "complete") counts[p.kind].complete++;
  }

  const nudges = computeNudges(ordered, sentences, edges, catalog);
  const ready =
    counts.input.total > 0 &&
    counts.output.total > 0 &&
    ordered.every((p) => sentences[p.id]!.status === "complete") &&
    looseEnds.length === 0 &&
    !nudges.some((n) => n.level === "warn");

  return { sentences, edges, looseEnds, nudges, counts, ready };
}

function computeNudges(pieces: PieceData[], sentences: Record<string, Sentence>, edges: PlanAnalysis["edges"], catalog: Catalog): Nudge[] {
  const nudges: Nudge[] = [];
  const byKind = (k: PieceKind) => pieces.filter((p) => p.kind === k);
  const usedBy = (id: string) => edges.filter((e) => e.from === id).map((e) => e.to);

  if (pieces.length === 0) {
    nudges.push({ id: "start", level: "info", text: "Start with an input: where does the information live today?" });
    return nudges;
  }

  for (const p of pieces) {
    const s = sentences[p.id]!;
    if (s.status !== "complete") {
      const blanks = s.tokens
        .filter((t) => t.type === "slot" && !t.spec.optional && (!t.value || t.value.kind === "unsure"))
        .map((t) => (t.type === "slot" ? t.spec.placeholder : ""))
        .filter(Boolean);
      if (blanks.length)
        nudges.push({
          id: `blank:${p.id}`,
          level: "info",
          text: `${PIECE_KIND_LABEL[p.kind].singular} “${s.label}” still needs: ${blanks.join(", ")}.`,
          pieceId: p.id,
          slotId: s.missing[0],
        });
    }
    if (p.kind !== "output" && s.status !== "empty" && usedBy(p.id).length === 0) {
      nudges.push({
        id: `unused:${p.id}`,
        level: "warn",
        text: `Nothing uses “${s.label}” yet. Point a transformation or an output at it, or remove it.`,
        pieceId: p.id,
      });
    }
    if (p.kind === "transform") {
      const op = findOperation(catalog, optionId(p, "operation"));
      if (op?.id === "ask_ai") {
        const instruction = textOf(p, "p.instruction") ?? "";
        if (instruction && instruction.split(/\s+/).length < 6)
          nudges.push({
            id: `vague:${p.id}`,
            level: "warn",
            text: `“${instruction}” is short for an AI instruction. Say what should happen to each item, and what the result should look like.`,
            pieceId: p.id,
            slotId: "p.instruction",
          });
      }
    }
  }

  if (byKind("input").length === 0) nudges.push({ id: "no-input", level: "warn", text: "There is no input yet. Every plan starts with where the information comes from." });
  if (byKind("output").length === 0 && byKind("input").length > 0)
    nudges.push({ id: "no-output", level: "warn", text: "Where should the result go? Add an expected output so the plan has an end." });

  const aiPieces = pieces.filter((p) => sentences[p.id]!.ai);
  if (aiPieces.length)
    nudges.push({
      id: "ai",
      level: "info",
      text: `${aiPieces.length === 1 ? "One step needs" : `${aiPieces.length} steps need`} an AI model when built. If tone, length, or format matter, put them in the piece notes.`,
    });

  const allComplete = pieces.every((p) => sentences[p.id]!.status === "complete");
  const looseEnds = pieces.flatMap((p) => sentences[p.id]!.unsure);
  if (looseEnds.length)
    nudges.push({ id: "loose", level: "info", text: `${looseEnds.length} loose ${looseEnds.length === 1 ? "end" : "ends"} to settle before handoff.` });
  if (allComplete && looseEnds.length === 0 && byKind("input").length && byKind("output").length && !nudges.some((n) => n.level === "warn"))
    nudges.push({ id: "ready", level: "done", text: "Every piece is complete and connected. Open Handoff to review the plan." });

  return nudges;
}
