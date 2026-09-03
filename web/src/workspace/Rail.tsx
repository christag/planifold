import { PIECE_KIND_LABEL, PIECE_KINDS, type PieceKind } from "@planifold/shared";
import { useState } from "react";
import { usePlan } from "../lib/planStore.js";
import { Plus, X } from "../ui/icons.js";

/** The plan at a glance: the thought, what to remember, every piece, every loose end. */
export function Rail() {
  const plan = usePlan((s) => s.plan)!;
  const pieces = usePlan((s) => s.pieces);
  const analysis = usePlan((s) => s.analysis);
  const focusId = usePlan((s) => s.focusId);
  const focus = usePlan((s) => s.focus);
  const addPiece = usePlan((s) => s.addPiece);
  const updatePlan = usePlan((s) => s.updatePlan);
  const addFact = usePlan((s) => s.addFact);
  const removeFact = usePlan((s) => s.removeFact);
  const [editingThought, setEditingThought] = useState(false);
  const [fact, setFact] = useState("");

  const ordered = [...pieces].sort((a, b) => a.position - b.position);

  return (
    <div className="rail">
      <section className="rail-section">
        <div className="eyebrow">The thought</div>
        {editingThought ? (
          <textarea
            className="textarea serif rail-thought-edit"
            defaultValue={plan.thought}
            autoFocus
            rows={4}
            aria-label="The thought"
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v !== plan.thought) void updatePlan({ thought: v });
              setEditingThought(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") setEditingThought(false);
            }}
          />
        ) : (
          <button className="rail-thought serif" onClick={() => setEditingThought(true)} title="Edit the thought">
            {plan.thought || "Write down what you want to happen."}
          </button>
        )}
      </section>

      <section className="rail-section">
        <div className="eyebrow">Things to remember</div>
        {plan.facts.length === 0 && <p className="tiny muted">Details a builder must know. Plani adds them as you talk; you can too.</p>}
        <ul className="rail-facts">
          {plan.facts.map((f, i) => (
            <li key={`${i}-${f}`}>
              <span>{f}</span>
              <button className="btn ghost icon sm" aria-label="Remove" onClick={() => void removeFact(i)}>
                <X />
              </button>
            </li>
          ))}
        </ul>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void addFact(fact);
            setFact("");
          }}
        >
          <input className="input rail-fact-input" value={fact} onChange={(e) => setFact(e.target.value)} placeholder="Add something to remember" aria-label="Add something to remember" />
        </form>
      </section>

      {PIECE_KINDS.map((kind) => (
        <PieceGroup key={kind} kind={kind} pieces={ordered.filter((p) => p.kind === kind)} />
      ))}

      {analysis && analysis.looseEnds.length > 0 && (
        <section className="rail-section">
          <div className="eyebrow">Loose ends</div>
          <ul className="rail-loose">
            {analysis.looseEnds.map((le) => (
              <li key={`${le.pieceId}-${le.slotId}`}>
                <button onClick={() => focus(le.pieceId, le.slotId)}>
                  <span className="small">{le.placeholder}</span>
                  <span className="tiny muted">
                    {le.pieceLabel}
                    {le.note ? ` · ${le.note}` : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );

  function PieceGroup({ kind, pieces }: { kind: PieceKind; pieces: typeof ordered }) {
    return (
      <section className={`rail-section kind-${kind}`}>
        <div className="spread">
          <div className="eyebrow" style={{ color: "var(--kind)" }}>
            {PIECE_KIND_LABEL[kind].plural}
          </div>
          <span className="tiny muted">{pieces.length}</span>
        </div>
        <ul className="rail-pieces">
          {pieces.map((p, i) => {
            const s = analysis?.sentences[p.id];
            return (
              <li key={p.id}>
                <button className={`rail-piece${focusId === p.id ? " active" : ""}`} onClick={() => focus(p.id)} aria-current={focusId === p.id ? "true" : undefined}>
                  <span className={`status-dot ${s?.status ?? "empty"}`} aria-hidden />
                  <span className="rail-piece-label">
                    <span className="tiny muted">{i + 1}</span> {s?.label ?? "…"}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <button className="rail-add" onClick={() => void addPiece(kind)}>
          <Plus /> Add {kind === "input" ? "an input" : kind === "transform" ? "a transformation" : "an expected output"}
        </button>
      </section>
    );
  }
}
