import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../lib/api.js";
import { relativeTime } from "../lib/format.js";
import { errorMessage, useApp } from "../lib/store.js";
import type { Plan } from "../lib/types.js";
import { Shell } from "../ui/Shell.js";
import { Plus, Trash } from "../ui/icons.js";
import { Confirm, EmptyState, Spinner } from "../ui/primitives.js";

const STATUS: Record<Plan["status"], { label: string; cls: string }> = {
  draft: { label: "Draft", cls: "" },
  ready: { label: "Ready", cls: "ok" },
  handed_off: { label: "Handed off", cls: "pen" },
};

export function PlansPage() {
  const user = useApp((s) => s.user)!;
  const toast = useApp((s) => s.toast);
  const navigate = useNavigate();
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [all, setAll] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.plans
      .list(all)
      .then((r) => live && setPlans(r.plans))
      .catch((e) => toast(errorMessage(e), "danger"));
    return () => {
      live = false;
    };
  }, [all, toast]);

  async function remove(id: string) {
    try {
      await api.plans.remove(id);
      setPlans((p) => (p ? p.filter((x) => x.id !== id) : p));
      setConfirmId(null);
      toast("Plan deleted.");
    } catch (e) {
      toast(errorMessage(e), "danger");
    }
  }

  return (
    <Shell>
      <div className="spread" style={{ marginBottom: 20 }}>
        <div>
          <h1>Plans</h1>
          <p className="muted small">Each plan turns one thought into pieces.</p>
        </div>
        <div className="row">
          {user.role === "app_admin" && (
            <label className="checkbox small muted">
              <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Everyone's plans
            </label>
          )}
          <button className="btn primary" onClick={() => navigate("/new")}>
            <Plus /> New plan
          </button>
        </div>
      </div>
      {!plans ? (
        <Spinner label="Loading plans" />
      ) : plans.length === 0 ? (
        <div className="card">
          <EmptyState
            title="No plans yet"
            action={
              <button className="btn primary" onClick={() => navigate("/new")}>
                <Plus /> Start with a thought
              </button>
            }
          >
            Write down what you want to happen, in your own words. Piecewise will help you break it into pieces.
          </EmptyState>
        </div>
      ) : (
        <div className="plan-grid">
          {plans.map((p) => (
            <article key={p.id} className="card plan-card">
              <Link to={`/plans/${p.id}`} className="plan-card-body">
                <div className="spread">
                  <h2 className="plan-card-title">{p.title}</h2>
                  <span className={`pill ${STATUS[p.status].cls}`}>{STATUS[p.status].label}</span>
                </div>
                <p className="plan-card-thought serif">{p.thought || "No thought written yet."}</p>
                <div className="row tiny muted" style={{ marginTop: "auto" }}>
                  <span>
                    {p.pieceCount ?? 0} piece{p.pieceCount === 1 ? "" : "s"}
                  </span>
                  <span aria-hidden>·</span>
                  <span>Updated {relativeTime(p.updatedAt)}</span>
                  {all && p.ownerName && (
                    <>
                      <span aria-hidden>·</span>
                      <span>{p.ownerName}</span>
                    </>
                  )}
                </div>
              </Link>
              <div className="plan-card-actions">
                {confirmId === p.id ? (
                  <Confirm question="Delete this plan?" onConfirm={() => remove(p.id)} onCancel={() => setConfirmId(null)} />
                ) : (
                  <button className="btn ghost icon sm" aria-label={`Delete ${p.title}`} onClick={() => setConfirmId(p.id)}>
                    <Trash />
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </Shell>
  );
}
