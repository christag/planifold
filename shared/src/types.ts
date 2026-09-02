/**
 * Core data types shared by the server and the web app.
 *
 * A plan is a small set of pieces. Every piece is one sentence with blanks
 * (slots). The grammar engine turns a piece's slot values into the tokens
 * that make up that sentence, and tells you what is still missing.
 */

export type PieceKind = "input" | "transform" | "output";
export const PIECE_KINDS: readonly PieceKind[] = ["input", "transform", "output"] as const;

export const PIECE_KIND_LABEL: Record<PieceKind, { singular: string; plural: string }> = {
  input: { singular: "Input", plural: "Inputs" },
  transform: { singular: "Transformation", plural: "Transformations" },
  output: { singular: "Expected output", plural: "Expected outputs" },
};

export type SlotValue =
  | { kind: "option"; id: string }
  | { kind: "text"; text: string }
  | { kind: "ref"; pieceId: string }
  | { kind: "unsure"; note?: string };

export interface PieceData {
  id: string;
  kind: PieceKind;
  slots: Record<string, SlotValue>;
  /** User-chosen name for the piece. Falls back to an automatic label. */
  label?: string | null;
  /** Free-form notes for whoever builds this. */
  notes?: string | null;
  position: number;
}

export interface SlotOption {
  id: string;
  label: string;
  description?: string;
  group?: string;
  /** Present when the option points at another piece. */
  pieceId?: string;
}

export type TextType = "text" | "number" | "date";

export interface SlotSpec {
  id: string;
  /** Shown inside the blank while it is empty. */
  placeholder: string;
  options: SlotOption[];
  allowText?: boolean;
  textHint?: string;
  textType?: TextType;
  /** Words shown before a typed value, e.g. "since" -> "since 1 Jan". */
  textPrefix?: string;
  optional?: boolean;
  /** One line of help shown at the top of the slot menu. */
  help?: string;
}

export type Token =
  | { type: "text"; text: string }
  | {
      type: "slot";
      spec: SlotSpec;
      value?: SlotValue;
      /** Human-readable value, or null when the slot is empty or unsure. */
      display: string | null;
      refPieceId?: string;
    };

export type PieceStatus = "empty" | "partial" | "complete";

export interface LooseEnd {
  slotId: string;
  placeholder: string;
  note?: string;
}

export interface Sentence {
  tokens: Token[];
  status: PieceStatus;
  /** Effective label: the user's name for the piece, or the automatic one. */
  label: string;
  autoLabel: string;
  /** Plain-text rendering with blanks written as [placeholder]. */
  text: string;
  /** Required slot ids that are empty or marked unsure. */
  missing: string[];
  unsure: LooseEnd[];
  /** Ids of pieces this piece reads from. */
  refs: string[];
  /** Every slot id the grammar visited; anything else in `slots` is stale. */
  visited: string[];
  /** Slot ids whose stored value no longer fits the available options. */
  invalid: string[];
  /** True when the piece involves an AI step. */
  ai: boolean;
}

export interface PlanData {
  id: string;
  title: string;
  thought: string;
  facts: string[];
  status: "draft" | "ready" | "handed_off";
}

export type NudgeLevel = "info" | "warn" | "done";

export interface Nudge {
  id: string;
  level: NudgeLevel;
  text: string;
  pieceId?: string;
  slotId?: string;
}

export interface PlanAnalysis {
  sentences: Record<string, Sentence>;
  edges: Array<{ from: string; to: string }>;
  looseEnds: Array<LooseEnd & { pieceId: string; pieceLabel: string }>;
  nudges: Nudge[];
  counts: Record<PieceKind, { total: number; complete: number }>;
  ready: boolean;
}
