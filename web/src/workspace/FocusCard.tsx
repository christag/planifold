import { PIECE_KIND_LABEL, type PieceKind } from "@planifold/shared";
import { useEffect, useRef, useState } from "react";
import { usePlan } from "../lib/planStore.js";
import { ArrowLeft, ArrowRight, Check, More, Plus, Sparkles, Trash } from "../ui/icons.js";
import { Confirm, Popover } from "../ui/primitives.js";
import { Sentence } from "./Sentence.js";

const KIND_HINT: Record<PieceKind, string> = {
  input: "Where the information lives today.",
  transform: "What has to change on the way.",
  output: "Where the result ends up, and how you'll know it worked.",
};

export function AddPieceMenu({ anchor, onClose }: { anchor: HTMLElement | null; onClose(): void }) {
  const addPiece = usePlan((s) => s.addPiece);
  return (
    <Popover anchor={anchor} onClose={onClose} label="Add a piece" width={300}>
      <div className="menu-list" role="menu">
        {(["input", "transform", "output"] as PieceKind[]).map((k) => (
          <button
            key={k}
            className={`menu-item kind-${k}`}
            role="menuitem"
            onClick={() => {
              onClose();
              void addPiece(k);
            }}
          >
            <span className="kind-dot" />
            <span>
              <span style={{ fontWeight: 500 }}>{PIECE_KIND_LABEL[k].singular}</span>
              <span className="tiny muted" style={{ display: "block" }}>
                {KIND_HINT[k]}
              </span>
            </span>
          </button>
        ))}
      </div>
    </Popover>
  );
}

/** One piece, front and center. Everything else steps back. */
export function FocusCard() {
  const pieces = usePlan((s) => s.pieces);
  const analysis = usePlan((s) => s.analysis);
  const focusId = usePlan((s) => s.focusId);
  const focus = usePlan((s) => s.focus);
  const renamePiece = usePlan((s) => s.renamePiece);
  const setNotes = usePlan((s) => s.setNotes);
  const removePiece = usePlan((s) => s.removePiece);
  const ask = usePlan((s) => s.ask);
  const justCompleted = usePlan((s) => s.justCompleted);
  const [renaming, setRenaming] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const addBtn = useRef<HTMLButtonElement>(null);
  const menuBtn = useRef<HTMLButtonElement>(null);

  const ordered = [...pieces].sort((a, b) => a.position - b.position);
  const piece = ordered.find((p) => p.id === focusId) ?? null;
  const sentence = piece && analysis ? analysis.sentences[piece.id] : null;

  useEffect(() => {
    setRenaming(false);
    setConfirmDelete(false);
  }, [focusId]);

  if (!piece || !sentence) {
    return (
      <div className="focus focus-empty">
        <div className="eyebrow">Start here</div>
        <h2 className="serif" style={{ fontSize: "1.6rem", fontWeight: 400 }}>
          Every plan begins with an input.
        </h2>
        <p className="muted">Where does the information live today? Add an input and fill in the first blank.</p>
        <button ref={addBtn} className="btn primary" onClick={() => setAddOpen(true)}>
          <Plus /> Add a piece
        </button>
        {addOpen && <AddPieceMenu anchor={addBtn.current} onClose={() => setAddOpen(false)} />}
      </div>
    );
  }

  const sameKind = ordered.filter((p) => p.kind === piece.kind);
  const kindIndex = sameKind.findIndex((p) => p.id === piece.id) + 1;
  const idx = ordered.findIndex((p) => p.id === piece.id);
  const prev = ordered[idx - 1];
  const next = ordered[idx + 1];
  const status = sentence.status;
  const statusLabel = status === "complete" ? "Complete" : status === "partial" ? `${sentence.missing.length} blank${sentence.missing.length === 1 ? "" : "s"} left` : "Empty";

  return (
    <div className={`focus kind-${piece.kind}`} key={piece.id}>
      <div className="focus-head">
        <div className="row">
          <span className="kind-dot" />
          <span className="eyebrow" style={{ color: "var(--kind)" }}>
            {PIECE_KIND_LABEL[piece.kind].singular} · {kindIndex} of {sameKind.length}
          </span>
        </div>
        <div className="row">
          <span className={`pill ${status === "complete" ? "ok" : ""}${justCompleted === piece.id ? " pulse" : ""}`}>
            {status === "complete" && <Check />}
            {statusLabel}
          </span>
          {sentence.ai && <span className="pill pen">AI step</span>}
          <button ref={menuBtn} className="btn ghost icon sm" aria-label="Piece options" onClick={() => setMenuOpen(true)}>
            <More />
          </button>
          {menuOpen && (
            <Popover anchor={menuBtn.current} onClose={() => setMenuOpen(false)} label="Piece options" width={240}>
              <div className="menu-list" role="menu">
                <button
                  className="menu-item"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    setRenaming(true);
                  }}
                >
                  Rename this piece
                </button>
                <button
                  className="menu-item danger"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    setConfirmDelete(true);
                  }}
                >
                  <Trash /> Delete this piece
                </button>
              </div>
            </Popover>
          )}
        </div>
      </div>

      <Sentence piece={piece} sentence={sentence} />

      {confirmDelete && (
        <div className="notice danger">
          <Confirm question={`Delete “${sentence.label}”? Pieces that use it will lose the reference.`} onConfirm={() => void removePiece(piece.id)} onCancel={() => setConfirmDelete(false)} />
        </div>
      )}

      <div className="focus-meta">
        <div className="focus-name">
          <span className="tiny muted">Called</span>
          {renaming ? (
            <input
              className="input"
              defaultValue={piece.label ?? ""}
              placeholder={sentence.autoLabel}
              autoFocus
              aria-label="Name for this piece"
              onBlur={(e) => {
                void renamePiece(piece.id, e.target.value.trim() || null);
                setRenaming(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") setRenaming(false);
              }}
            />
          ) : (
            <button className="focus-name-btn serif" onClick={() => setRenaming(true)} title="Rename">
              {sentence.label}
            </button>
          )}
        </div>
        <button className="btn ghost sm" onClick={() => void ask({ intent: "slot", focus: { pieceId: piece.id, slotId: sentence.missing[0] } })}>
          <Sparkles /> Help me with this piece
        </button>
      </div>

      <NotesField key={piece.id} pieceId={piece.id} initial={piece.notes ?? ""} onSave={(v) => void setNotes(piece.id, v)} />

      <div className="focus-nav">
        <button className="btn ghost" disabled={!prev} onClick={() => prev && focus(prev.id)}>
          <ArrowLeft /> {prev ? analysis!.sentences[prev.id]!.label : "Previous"}
        </button>
        <button ref={addBtn} className="btn" onClick={() => setAddOpen(true)}>
          <Plus /> Add piece
        </button>
        <button className="btn ghost" disabled={!next} onClick={() => next && focus(next.id)}>
          {next ? analysis!.sentences[next.id]!.label : "Next"} <ArrowRight />
        </button>
      </div>
      {addOpen && <AddPieceMenu anchor={addBtn.current} onClose={() => setAddOpen(false)} />}
    </div>
  );
}

function NotesField({ pieceId, initial, onSave }: { pieceId: string; initial: string; onSave(v: string): void }) {
  const [value, setValue] = useState(initial);
  const [open, setOpen] = useState(!!initial);
  const timer = useRef<number | undefined>(undefined);
  const saved = useRef(initial);
  useEffect(() => () => window.clearTimeout(timer.current), [pieceId]);
  const change = (v: string) => {
    setValue(v);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      if (v !== saved.current) {
        saved.current = v;
        onSave(v);
      }
    }, 600);
  };
  if (!open)
    return (
      <button className="focus-notes-toggle" onClick={() => setOpen(true)}>
        + Add a note for whoever builds this
      </button>
    );
  return (
    <div className="field focus-notes">
      <label htmlFor={`notes-${pieceId}`}>Notes for whoever builds this</label>
      <textarea
        id={`notes-${pieceId}`}
        className="textarea"
        value={value}
        onChange={(e) => change(e.target.value)}
        onBlur={() => {
          window.clearTimeout(timer.current);
          if (value !== saved.current) {
            saved.current = value;
            onSave(value);
          }
        }}
        placeholder="Anything the sentence can't say: exceptions, examples, who to ask."
        rows={2}
        autoFocus={!initial}
      />
    </div>
  );
}
