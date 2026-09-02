import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Link } from "react-router-dom";
import { usePlan } from "../lib/planStore.js";
import { useApp } from "../lib/store.js";
import type { HelperMessage, Suggestion } from "../lib/types.js";
import { AlertTriangle, ArrowRight, Check, Info, Sparkles, Trash } from "../ui/icons.js";

function SuggestionCard({ s, messageId, index }: { s: Suggestion; messageId: string; index: number }) {
  const applySuggestion = usePlan((s2) => s2.applySuggestion);
  const [applied, setApplied] = useState(false);
  const [busy, setBusy] = useState(false);
  const key = `${messageId}:${index}`;
  useEffect(() => {
    try {
      setApplied(sessionStorage.getItem(`piecewise.applied.${key}`) === "1");
    } catch {
      /* ignore */
    }
  }, [key]);
  const apply = async () => {
    setBusy(true);
    await applySuggestion(s);
    setBusy(false);
    setApplied(true);
    try {
      sessionStorage.setItem(`piecewise.applied.${key}`, "1");
    } catch {
      /* ignore */
    }
  };
  return (
    <div className={`suggestion kind-${s.kind}`}>
      <div className="row">
        <span className="kind-dot" />
        <span className="small" style={{ fontWeight: 500 }}>
          {s.title}
        </span>
        {s.pieceId ? <span className="pill" title="Fills an existing piece">fills</span> : <span className="pill" title="Adds a new piece">new</span>}
      </div>
      <p className="suggestion-preview serif">{s.preview}</p>
      {s.why && <p className="tiny muted">{s.why}</p>}
      <div className="row">
        {s.valid ? (
          <button className="btn sm" onClick={apply} disabled={busy || applied}>
            {applied ? (
              <>
                <Check /> Applied
              </>
            ) : busy ? (
              "Applying…"
            ) : (
              "Apply"
            )}
          </button>
        ) : (
          <span className="tiny muted">Couldn't be matched to the catalog, so there's nothing to apply.</span>
        )}
        {s.dropped.length > 0 && s.valid && <span className="tiny muted">{s.dropped.length} part{s.dropped.length === 1 ? "" : "s"} left blank</span>}
      </div>
    </div>
  );
}

function Message({ m }: { m: HelperMessage }) {
  if (m.role === "user")
    return (
      <div className="msg user">
        <div className="msg-bubble">{m.content}</div>
      </div>
    );
  const p = m.payload ?? {};
  return (
    <div className="msg assistant">
      {p.notice && (
        <div className="notice warn tiny">
          <AlertTriangle /> {p.notice}
        </div>
      )}
      <div className="msg-bubble">
        {m.content.split(/\n{2,}/).map((para, i) => (
          <p key={i}>{para}</p>
        ))}
      </div>
      {p.suggestions && p.suggestions.length > 0 && (
        <div className="stack">
          {p.suggestions.map((s, i) => (
            <SuggestionCard key={i} s={s} messageId={m.id} index={i} />
          ))}
        </div>
      )}
      {p.questions && p.questions.length > 0 && (
        <div className="msg-questions">
          <div className="tiny muted">Only you can answer:</div>
          <ul>
            {p.questions.map((q, i) => (
              <li key={i} className="small">
                {q}
              </li>
            ))}
          </ul>
        </div>
      )}
      {p.remember && p.remember.length > 0 && (
        <div className="tiny muted">
          Saved to things to remember: {p.remember.join(" · ")}
        </div>
      )}
      {p.source && <div className="tiny faint msg-source">{p.source === "model" ? p.model : "from the plan's own rules"}</div>}
    </div>
  );
}

/** Always on. Talks about the plan, proposes fills, never applies them itself. */
export function HelperPanel({ onClose }: { onClose?: () => void }) {
  const messages = usePlan((s) => s.messages);
  const analysis = usePlan((s) => s.analysis);
  const busy = usePlan((s) => s.helperBusy);
  const ask = usePlan((s) => s.ask);
  const clearHelper = usePlan((s) => s.clearHelper);
  const focus = usePlan((s) => s.focus);
  const focusId = usePlan((s) => s.focusId);
  const status = useApp((s) => s.helperStatus);
  const user = useApp((s) => s.user);
  const [text, setText] = useState("");
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, busy]);

  const send = () => {
    const message = text.trim();
    if (!message || busy) return;
    setText("");
    void ask({ message, intent: "chat", focus: focusId ? { pieceId: focusId } : undefined });
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const nudges = (analysis?.nudges ?? []).slice(0, 3);

  return (
    <div className="helper">
      <div className="helper-head">
        <div className="row">
          <Sparkles />
          <span style={{ fontWeight: 600 }}>Helper</span>
          {status && (
            <span className={`pill ${status.configured ? "pen" : ""}`} title={status.configured ? `${status.provider?.label}: ${status.provider?.model}` : "No AI model is configured. Guidance comes from the plan's own rules."}>
              {status.configured ? status.provider?.model : "rules only"}
            </span>
          )}
        </div>
        <div className="row">
          {messages.length > 0 && (
            <button className="btn ghost icon sm" aria-label="Clear conversation" title="Clear conversation" onClick={() => void clearHelper()}>
              <Trash />
            </button>
          )}
          {onClose && (
            <button className="btn ghost sm" onClick={onClose}>
              Done
            </button>
          )}
        </div>
      </div>
      {status && !status.configured && user?.role === "app_admin" && (
        <div className="helper-setup tiny">
          <Info /> No AI model yet. <Link to="/admin/ai">Add one in Admin → AI</Link> to get suggestions written for this plan.
        </div>
      )}
      <div className="helper-scroll" ref={scroller}>
        {nudges.length > 0 && (
          <div className="nudges">
            {nudges.map((n) => (
              <div key={n.id} className={`nudge ${n.level}`}>
                {n.level === "warn" ? <AlertTriangle /> : n.level === "done" ? <Check /> : <Info />}
                <span className="small">{n.text}</span>
                {n.pieceId && (
                  <button className="btn ghost icon sm" aria-label="Go to this piece" onClick={() => focus(n.pieceId!, n.slotId ?? null)}>
                    <ArrowRight />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        {messages.length === 0 && !busy && (
          <div className="helper-empty">
            <p className="small muted">Ask anything about this plan. Or open a blank and choose “Help me with this”.</p>
            <div className="row wrap">
              <button className="btn sm" onClick={() => void ask({ intent: "breakdown" })}>
                Break the thought into pieces
              </button>
              <button className="btn sm" onClick={() => void ask({ intent: "review" })}>
                Review the plan
              </button>
            </div>
          </div>
        )}
        {messages.map((m) => (
          <Message key={m.id} m={m} />
        ))}
        {busy && (
          <div className="msg assistant">
            <div className="msg-bubble thinking">
              <span className="spinner" /> Thinking…
            </div>
          </div>
        )}
      </div>
      <div className="helper-compose">
        {messages.length > 0 && (
          <div className="row wrap" style={{ gap: 6 }}>
            <button className="example-chip" onClick={() => void ask({ intent: "breakdown" })} disabled={busy}>
              Break it down
            </button>
            <button className="example-chip" onClick={() => void ask({ intent: "review" })} disabled={busy}>
              Review the plan
            </button>
          </div>
        )}
        <div className="row" style={{ alignItems: "flex-end" }}>
          <textarea className="textarea" rows={1} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} placeholder="Ask the helper…" aria-label="Message the helper" disabled={busy} />
          <button className="btn primary icon" onClick={send} disabled={busy || !text.trim()} aria-label="Send">
            <ArrowRight />
          </button>
        </div>
      </div>
    </div>
  );
}
