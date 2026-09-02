import type { Sentence as SentenceData, Token } from "@piecewise/shared";
import { useEffect, useRef, useState } from "react";
import { usePlan } from "../lib/planStore.js";
import type { Piece } from "../lib/types.js";
import { SlotMenu } from "./SlotMenu.js";

type SlotToken = Extract<Token, { type: "slot" }>;

function slotState(t: SlotToken): string {
  if (t.value?.kind === "unsure") return "unsure";
  if (t.value && t.display !== null) return t.value.kind === "ref" ? "filled ref" : t.value.kind === "text" ? "filled text" : "filled";
  return t.spec.optional ? "empty optional" : "empty";
}

/**
 * The sentence is the product. Blanks are buttons; the menu that fills them
 * is anchored to the blank so the eye never leaves the line.
 */
export function Sentence({ piece, sentence, interactive = true, size = "lg" }: { piece: Piece; sentence: SentenceData; interactive?: boolean; size?: "lg" | "sm" }) {
  const openSlot = usePlan((s) => s.openSlot);
  const setOpenSlot = usePlan((s) => s.setOpenSlot);
  const anchors = useRef<Record<string, HTMLButtonElement | null>>({});
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const prevCount = useRef(sentence.tokens.length);
  const [newFrom, setNewFrom] = useState<number>(Infinity);

  useEffect(() => {
    if (sentence.tokens.length > prevCount.current) setNewFrom(prevCount.current);
    else setNewFrom(Infinity);
    prevCount.current = sentence.tokens.length;
  }, [sentence.tokens.length]);

  useEffect(() => {
    if (!interactive) return;
    const el = openSlot ? (anchors.current[openSlot] ?? null) : null;
    setAnchor(el);
    if (el) el.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [openSlot, sentence.tokens, interactive]);

  const openToken = openSlot ? sentence.tokens.find((t): t is SlotToken => t.type === "slot" && t.spec.id === openSlot) : undefined;

  // Presentation: unfilled optional blanks trail the sentence as quiet offers,
  // so the period lands right after the last real word.
  const main: Array<[number, Token]> = [];
  const extras: Array<[number, Token]> = [];
  sentence.tokens.forEach((t, i) => {
    if (t.type === "slot" && t.spec.optional && (!t.value || t.value.kind === "unsure")) extras.push([i, t]);
    else main.push([i, t]);
  });

  const renderToken = (t: Token, i: number, prev: Token | undefined) => {
    const cls = i >= newFrom ? " tok-new" : "";
    const punct = t.type === "text" && /^[.,;:?!]/.test(t.text);
    const space = prev && !punct ? " " : "";
    if (t.type === "text") {
      return (
        <span key={`${i}-${t.text}`} className={`tok${punct ? " punct" : ""}${cls}`}>
          {space}
          {t.text}
        </span>
      );
    }
    const state = slotState(t);
    const label = t.value?.kind === "unsure" ? `not sure: ${t.spec.placeholder}` : (t.display ?? (t.spec.optional ? `+ ${t.spec.placeholder}` : t.spec.placeholder));
    const prefix = t.value?.kind === "text" && t.spec.textPrefix ? `${t.spec.textPrefix} ` : "";
    return (
      <span key={`${i}-${t.spec.id}`} className={`slot-wrap${cls}`}>
        {space}
        <button
          type="button"
          ref={(el) => {
            anchors.current[t.spec.id] = el;
          }}
          className={`slot ${state}${openSlot === t.spec.id ? " open" : ""}`}
          disabled={!interactive}
          aria-label={`${t.spec.placeholder}${t.display ? `: ${t.display}` : ", empty"}`}
          aria-haspopup="listbox"
          aria-expanded={openSlot === t.spec.id}
          onClick={() => setOpenSlot(openSlot === t.spec.id ? null : t.spec.id)}
        >
          {prefix}
          {t.value?.kind === "text" ? `“${t.display}”` : label}
        </button>
      </span>
    );
  };

  return (
    <p className={`sentence size-${size} kind-${piece.kind}`} aria-label={sentence.text}>
      {main.map(([i, t], idx) => renderToken(t, i, main[idx - 1]?.[1]))}
      {extras.length > 0 && (
        <span className="sentence-extras" aria-label="Optional details">
          {extras.map(([i, t]) => renderToken(t, i, undefined))}
        </span>
      )}
      {interactive && openToken && anchor && <SlotMenu key={`${piece.id}:${openToken.spec.id}`} piece={piece} token={openToken} anchor={anchor} onClose={() => setOpenSlot(null)} />}
    </p>
  );
}
