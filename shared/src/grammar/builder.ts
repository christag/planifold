import type { LooseEnd, PieceData, SlotOption, SlotSpec, SlotValue, Token } from "../types.js";
import type { GrammarContext } from "./context.js";

export interface Resolved {
  spec: SlotSpec;
  value?: SlotValue;
  display: string | null;
  refPieceId?: string;
  option?: SlotOption;
  /** Chosen option id, when the value is an option. */
  id?: string;
  /** Typed text, when the value is free text. */
  text?: string;
  /** True when the slot holds a usable value (not empty, not "unsure"). */
  filled: boolean;
}

/**
 * Collects the tokens of one sentence while validating stored slot values
 * against what the grammar currently offers.
 */
export class Builder {
  readonly tokens: Token[] = [];
  readonly missing: string[] = [];
  readonly unsure: LooseEnd[] = [];
  readonly refs = new Set<string>();
  readonly visited: string[] = [];
  readonly invalid: string[] = [];
  anyValue = false;
  ai = false;

  constructor(
    readonly piece: PieceData,
    readonly ctx: GrammarContext,
  ) {}

  text(t: string): void {
    if (t) this.tokens.push({ type: "text", text: t });
  }

  /** Validates the stored value for a slot without emitting it yet. */
  resolve(spec: SlotSpec): Resolved {
    this.visited.push(spec.id);
    const raw = this.piece.slots[spec.id];
    const r: Resolved = { spec, display: null, filled: false };
    if (raw) {
      switch (raw.kind) {
        case "option": {
          const o = spec.options.find((x) => x.id === raw.id && !x.pieceId);
          if (o) {
            r.value = raw;
            r.display = o.label;
            r.option = o;
            r.id = o.id;
            r.filled = true;
          } else this.invalid.push(spec.id);
          break;
        }
        case "ref": {
          const o = spec.options.find((x) => x.pieceId === raw.pieceId);
          if (o) {
            r.value = raw;
            r.display = o.label;
            r.option = o;
            r.refPieceId = raw.pieceId;
            r.filled = true;
            this.refs.add(raw.pieceId);
          } else this.invalid.push(spec.id);
          break;
        }
        case "text": {
          const text = raw.text.trim();
          if (spec.allowText && text) {
            r.value = { kind: "text", text };
            r.display = text;
            r.text = text;
            r.filled = true;
          } else this.invalid.push(spec.id);
          break;
        }
        case "unsure": {
          r.value = raw;
          this.unsure.push({ slotId: spec.id, placeholder: spec.placeholder, note: raw.note });
          break;
        }
      }
    }
    if (r.value) this.anyValue = true;
    if (!r.filled && !spec.optional) this.missing.push(spec.id);
    return r;
  }

  emit(r: Resolved): Resolved {
    this.tokens.push({ type: "slot", spec: r.spec, value: r.value, display: r.display, refPieceId: r.refPieceId });
    return r;
  }

  slot(spec: SlotSpec): Resolved {
    return this.emit(this.resolve(spec));
  }

  /** True when nothing required is missing so far; optional slots only appear then. */
  get settled(): boolean {
    return this.missing.length === 0;
  }
}
