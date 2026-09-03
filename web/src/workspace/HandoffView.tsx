import { PIECE_KIND_LABEL, PIECE_KINDS } from "@planifold/shared";
import { useEffect, useState } from "react";
import { api } from "../lib/api.js";
import { copyText, download } from "../lib/format.js";
import { Markdown } from "../lib/markdown.js";
import { usePlan } from "../lib/planStore.js";
import { errorMessage, useApp } from "../lib/store.js";
import type { HandoffResponse } from "../lib/types.js";
import { Copy, Download, Refresh, Sparkles } from "../ui/icons.js";
import { Spinner } from "../ui/primitives.js";

/** The deliverable: the plan as a document another person, or an AI, can build from. */
export function HandoffView() {
  const plan = usePlan((s) => s.plan)!;
  const pieces = usePlan((s) => s.pieces);
  const analysis = usePlan((s) => s.analysis);
  const updatePlan = usePlan((s) => s.updatePlan);
  const writeBrief = usePlan((s) => s.writeBrief);
  const busy = usePlan((s) => s.helperBusy);
  const setView = usePlan((s) => s.setView);
  const focus = usePlan((s) => s.focus);
  const toast = useApp((s) => s.toast);
  const [data, setData] = useState<HandoffResponse | null>(null);
  const stamp = JSON.stringify([plan.title, plan.thought, plan.facts, plan.brief, plan.status, pieces.map((p) => [p.id, p.slots, p.label, p.notes, p.position])]);

  useEffect(() => {
    let live = true;
    api.plans
      .handoff(plan.id)
      .then((r) => live && setData(r))
      .catch((e) => toast(errorMessage(e), "danger"));
    return () => {
      live = false;
    };
  }, [plan.id, stamp, toast]);

  if (!data || !analysis) return <Spinner label="Preparing the handoff" />;
  const { doc, markdown } = data;
  const slug = plan.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "plan";
  const incomplete = pieces.filter((p) => analysis.sentences[p.id]!.status !== "complete").length;

  return (
    <div className="handoff">
      <div className="handoff-actions">
        <button className="btn sm" onClick={async () => toast((await copyText(markdown)) ? "Copied as Markdown." : "Couldn't copy; download instead.")}>
          <Copy /> Copy Markdown
        </button>
        <button className="btn sm" onClick={() => download(`${slug}.md`, markdown, "text/markdown")}>
          <Download /> .md
        </button>
        <button className="btn sm" onClick={() => download(`${slug}.json`, JSON.stringify(doc, null, 2), "application/json")}>
          <Download /> .json
        </button>
        <div className="grow" />
        {plan.status === "handed_off" ? (
          <button className="btn sm" onClick={() => void updatePlan({ status: "draft" })}>
            Reopen as draft
          </button>
        ) : (
          <button className="btn sm primary" onClick={() => void updatePlan({ status: "handed_off" })} disabled={!analysis.ready}>
            Mark as handed off
          </button>
        )}
      </div>

      {!analysis.ready && (
        <div className="notice warn small">
          {incomplete > 0 ? `${incomplete} piece${incomplete === 1 ? " is" : "s are"} not complete yet. ` : ""}
          {analysis.looseEnds.length > 0 ? `${analysis.looseEnds.length} loose end${analysis.looseEnds.length === 1 ? "" : "s"} to settle. ` : ""}
          {analysis.nudges
            .filter((n) => n.level === "warn")
            .map((n) => n.text)
            .join(" ")}{" "}
          <button className="link-btn" onClick={() => setView("pieces")}>
            Back to the pieces
          </button>
        </div>
      )}

      <article className="handoff-doc">
        <header>
          <div className="eyebrow">Handoff · {plan.status.replace("_", " ")}</div>
          <h1 className="serif handoff-title">{plan.title}</h1>
          <blockquote className="serif handoff-thought">“{plan.thought || "No thought written."}”</blockquote>
          {plan.facts.length > 0 && (
            <div className="handoff-facts">
              <div className="eyebrow">Things to remember</div>
              <ul>
                {plan.facts.map((f, i) => (
                  <li key={i}>{f}</li>
                ))}
              </ul>
            </div>
          )}
        </header>

        {PIECE_KINDS.map((kind) => {
          const ps = doc.pieces.filter((p) => p.kind === kind);
          return (
            <section key={kind} className={`handoff-section kind-${kind}`}>
              <h2 className="handoff-h2">
                <span className="kind-dot" /> {PIECE_KIND_LABEL[kind].plural}
              </h2>
              {ps.length === 0 && <p className="small muted">None yet.</p>}
              {ps.map((p) => (
                <div key={p.id} className="handoff-piece">
                  <button className="handoff-number" onClick={() => focus(p.id)} title={`Open ${p.number}`} aria-label={`Open ${p.number}`}>
                    {p.number.split(" ").at(-1)}
                  </button>
                  <div className="grow">
                    <div className="row wrap">
                      <span className="small" style={{ fontWeight: 600 }}>
                        {p.label}
                      </span>
                      {p.ai && <span className="pill pen">AI step</span>}
                      {p.status !== "complete" && <span className="pill warn">{p.status}</span>}
                      {p.dependsOn.length > 0 && <span className="tiny muted">reads {p.dependsOn.join(", ")}</span>}
                    </div>
                    <p className="serif handoff-sentence">{p.sentence}</p>
                    {p.notes && <p className="small handoff-notes">{p.notes}</p>}
                    {p.looseEnds.length > 0 && (
                      <ul className="small handoff-loose">
                        {p.looseEnds.map((le, i) => (
                          <li key={i}>Not sure yet: {le}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              ))}
            </section>
          );
        })}

        {(doc.guidance.organization || doc.guidance.preferredBuilder || doc.integrations.some((i) => i.guidance || i.setupNotes)) && (
          <section className="handoff-section">
            <h2 className="handoff-h2">How this should be built</h2>
            {doc.guidance.preferredBuilder && (
              <p className="small">
                <strong>Preferred builder:</strong> {doc.guidance.preferredBuilder}
              </p>
            )}
            {doc.guidance.organization && <p className="small">{doc.guidance.organization}</p>}
            {doc.integrations
              .filter((i) => i.guidance || i.setupNotes)
              .map((i) => (
                <div key={i.id} className="handoff-integration">
                  <div className="small" style={{ fontWeight: 600 }}>
                    {i.name}
                  </div>
                  {i.guidance && <p className="small">{i.guidance}</p>}
                  {i.setupNotes && (
                    <p className="small muted">
                      <strong>Access:</strong> {i.setupNotes}
                    </p>
                  )}
                </div>
              ))}
          </section>
        )}

        <section className="handoff-section">
          <div className="spread">
            <h2 className="handoff-h2">Build brief</h2>
            <button className="btn sm" onClick={() => void writeBrief()} disabled={busy}>
              {busy ? <Spinner /> : plan.brief ? <Refresh /> : <Sparkles />} {plan.brief ? "Rewrite" : "Write the brief"}
            </button>
          </div>
          {plan.brief ? <Markdown text={plan.brief} className="small" /> : <p className="small muted">A build brief turns the pieces above into instructions for an engineer or an AI agent: steps, data and access needed, open questions, and the recommended way to build it.</p>}
        </section>
      </article>
    </div>
  );
}
