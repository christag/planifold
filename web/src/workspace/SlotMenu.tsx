import type { SlotOption, Token } from "@planifold/shared";
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { usePlan } from "../lib/planStore.js";
import type { Piece } from "../lib/types.js";
import { Check, HelpCircle, Sparkles, Unsure, X } from "../ui/icons.js";
import { Popover } from "../ui/primitives.js";

type SlotToken = Extract<Token, { type: "slot" }>;

/** The menu behind a blank: options, a place to type, and the two escape hatches. */
export function SlotMenu({ piece, token, anchor, onClose }: { piece: Piece; token: SlotToken; anchor: HTMLElement; onClose(): void }) {
  const setSlot = usePlan((s) => s.setSlot);
  const ask = usePlan((s) => s.ask);
  const { spec } = token;
  const [query, setQuery] = useState("");
  const [text, setText] = useState(token.value?.kind === "text" ? token.value.text : "");
  const [unsureNote, setUnsureNote] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchable = spec.options.length > 7;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return spec.options;
    return spec.options.filter((o) => o.label.toLowerCase().includes(q) || o.description?.toLowerCase().includes(q) || o.group?.toLowerCase().includes(q));
  }, [spec.options, query]);

  const groups = useMemo(() => {
    const map = new Map<string, SlotOption[]>();
    for (const o of filtered) {
      const g = o.group ?? "";
      map.set(g, [...(map.get(g) ?? []), o]);
    }
    return [...map.entries()];
  }, [filtered]);

  const choose = (o: SlotOption) => {
    void setSlot(piece.id, spec.id, o.pieceId ? { kind: "ref", pieceId: o.pieceId } : { kind: "option", id: o.id });
  };
  const chooseText = () => {
    if (!text.trim()) return;
    void setSlot(piece.id, spec.id, { kind: "text", text: text.trim() });
  };
  const clear = () => void setSlot(piece.id, spec.id, undefined);
  const markUnsure = (note?: string) => void setSlot(piece.id, spec.id, { kind: "unsure", note: note?.trim() || undefined });
  const helpMe = () => {
    onClose();
    void ask({ intent: "slot", focus: { pieceId: piece.id, slotId: spec.id } });
  };

  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(listRef.current?.querySelectorAll<HTMLElement>("[role='option']") ?? [])];
    const idx = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      items[Math.min(items.length - 1, idx + 1)]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (idx <= 0) (listRef.current?.parentElement?.querySelector<HTMLElement>("input") ?? items[0])?.focus();
      else items[idx - 1]?.focus();
    } else if (e.key === "Home") {
      items[0]?.focus();
    } else if (e.key === "End") {
      items.at(-1)?.focus();
    }
  };

  const isSelected = (o: SlotOption) => (token.value?.kind === "option" && token.value.id === o.id && !o.pieceId) || (token.value?.kind === "ref" && token.value.pieceId === o.pieceId);
  const inputType = spec.textType === "date" ? "date" : spec.textType === "number" ? "number" : "text";

  return (
    <Popover
      anchor={anchor}
      onClose={onClose}
      label={`Choose ${spec.placeholder}`}
      width={360}
      title={
        <div>
          <div className="small" style={{ fontWeight: 500 }}>
            {spec.help ?? spec.placeholder}
          </div>
          {spec.optional && <div className="tiny muted">Optional. Blank is a valid answer.</div>}
        </div>
      }
    >
      {searchable && (
        <div className="menu-search">
          <input
            className="input"
            placeholder={`Search ${spec.options.length} options…`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search options"
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                listRef.current?.querySelector<HTMLElement>("[role='option']")?.focus();
              }
            }}
          />
        </div>
      )}
      <div className="menu-scroll" ref={listRef} role="listbox" aria-label={spec.placeholder} onKeyDown={onListKey}>
        {groups.map(([group, options]) => (
          <div key={group} className="menu-group">
            {group && groups.length > 1 && <div className="menu-group-label eyebrow">{group}</div>}
            {options.map((o) => (
              <button key={o.pieceId ? `ref:${o.pieceId}` : o.id} type="button" role="option" aria-selected={isSelected(o)} className={`menu-option${o.pieceId ? " ref" : ""}`} onClick={() => choose(o)}>
                <span className="menu-option-main">
                  <span className={`menu-option-label${o.pieceId ? " serif" : ""}`}>{o.label}</span>
                  {o.description && <span className="menu-option-desc">{o.description}</span>}
                </span>
                {isSelected(o) && <Check />}
              </button>
            ))}
          </div>
        ))}
        {filtered.length === 0 && spec.options.length > 0 && <div className="menu-empty tiny muted">Nothing matches “{query}”.</div>}
        {spec.options.length === 0 && !spec.allowText && <div className="menu-empty tiny muted">Nothing to choose from yet. Fill the blanks before this one, or add the piece it should point at.</div>}
        {spec.allowText && (
          <form
            className="menu-text"
            onSubmit={(e) => {
              e.preventDefault();
              chooseText();
            }}
          >
            <label className="tiny muted" htmlFor={`text-${spec.id}`}>
              {spec.options.length ? "Or type your own" : "Type it in"}
            </label>
            <div className="row">
              <input
                id={`text-${spec.id}`}
                className="input"
                type={inputType}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={spec.textHint ?? "…"}
                autoFocus={!searchable && spec.options.length === 0}
                inputMode={spec.textType === "number" ? "decimal" : undefined}
              />
              <button type="submit" className="btn primary sm" disabled={!text.trim()}>
                Use
              </button>
            </div>
          </form>
        )}
      </div>
      <div className="menu-footer">
        {unsureNote === null ? (
          <>
            <button type="button" className="btn ghost sm" onClick={() => setUnsureNote("")} title="Mark as a loose end to settle later">
              <Unsure /> I'm not sure yet
            </button>
            <button type="button" className="btn ghost sm" onClick={helpMe}>
              <Sparkles /> Help me with this
            </button>
            {token.value && (
              <button type="button" className="btn ghost sm" onClick={clear} aria-label="Clear this blank" style={{ marginLeft: "auto" }}>
                <X /> Clear
              </button>
            )}
          </>
        ) : (
          <form
            className="row grow"
            onSubmit={(e) => {
              e.preventDefault();
              markUnsure(unsureNote);
            }}
          >
            <input className="input" value={unsureNote} onChange={(e) => setUnsureNote(e.target.value)} placeholder="What's unclear? (optional)" autoFocus aria-label="What are you unsure about" />
            <button type="submit" className="btn sm">
              <HelpCircle /> Save loose end
            </button>
          </form>
        )}
      </div>
    </Popover>
  );
}
