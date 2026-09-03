import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { api } from "../lib/api.js";
import { usePlan, type View } from "../lib/planStore.js";
import { errorMessage, useApp } from "../lib/store.js";
import { ChevronLeft, FileText, ListIcon, MapIcon, Menu, More, Sparkles, Trash } from "../ui/icons.js";
import { Confirm, Logo, Popover, Spinner, useIsMobile } from "../ui/primitives.js";
import { FocusCard } from "./FocusCard.js";
import { HandoffView } from "./HandoffView.js";
import { HelperPanel } from "./HelperPanel.js";
import { MapView } from "./MapView.js";
import { Rail } from "./Rail.js";

const VIEWS: Array<{ id: View; label: string; icon: typeof ListIcon }> = [
  { id: "pieces", label: "Pieces", icon: ListIcon },
  { id: "map", label: "Map", icon: MapIcon },
  { id: "handoff", label: "Handoff", icon: FileText },
];

export function PlanPage() {
  const { id } = useParams<{ id: string }>();
  const loc = useLocation();
  const navigate = useNavigate();
  const mobile = useIsMobile();
  const plan = usePlan((s) => s.plan);
  const pieces = usePlan((s) => s.pieces);
  const analysis = usePlan((s) => s.analysis);
  const loading = usePlan((s) => s.loading);
  const error = usePlan((s) => s.error);
  const saving = usePlan((s) => s.saving);
  const view = usePlan((s) => s.view);
  const setView = usePlan((s) => s.setView);
  const load = usePlan((s) => s.load);
  const reset = usePlan((s) => s.reset);
  const ask = usePlan((s) => s.ask);
  const messages = usePlan((s) => s.messages);
  const helperOpen = usePlan((s) => s.helperOpen);
  const setHelperOpen = usePlan((s) => s.setHelperOpen);
  const planSheetOpen = usePlan((s) => s.planSheetOpen);
  const setPlanSheetOpen = usePlan((s) => s.setPlanSheetOpen);
  const updatePlan = usePlan((s) => s.updatePlan);
  const focus = usePlan((s) => s.focus);
  const focusId = usePlan((s) => s.focusId);
  const toast = useApp((s) => s.toast);
  const catalog = useApp((s) => s.catalog);
  const [renaming, setRenaming] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const menuBtn = useRef<HTMLButtonElement>(null);
  const kicked = useRef(false);

  useEffect(() => {
    if (id) void load(id);
    return () => reset();
  }, [id, load, reset]);

  // A fresh plan gets one automatic breakdown so the first screen isn't empty.
  useEffect(() => {
    const fresh = (loc.state as { fresh?: boolean } | null)?.fresh;
    if (plan && fresh && !kicked.current && messages.length === 0 && plan.thought) {
      kicked.current = true;
      navigate(loc.pathname, { replace: true, state: null });
      void ask({ intent: "breakdown" });
    }
  }, [plan, loc.state, loc.pathname, messages.length, ask, navigate]);

  if (error)
    return (
      <div className="page narrow">
        <div className="notice danger">{error}</div>
        <p style={{ marginTop: 12 }}>
          <Link to="/">Back to plans</Link>
        </p>
      </div>
    );
  if (!plan || loading || !catalog || !analysis)
    return (
      <div className="splash">
        <Spinner label="Opening the plan" />
      </div>
    );

  const complete = pieces.filter((p) => analysis.sentences[p.id]!.status === "complete").length;
  const readiness = plan.status === "handed_off" ? { label: "Handed off", cls: "pen" } : analysis.ready ? { label: "Ready to hand off", cls: "ok" } : { label: `${complete}/${pieces.length} pieces complete`, cls: "" };

  async function deletePlan() {
    try {
      await api.plans.remove(plan!.id);
      toast("Plan deleted.");
      navigate("/");
    } catch (e) {
      toast(errorMessage(e), "danger");
    }
  }

  const orderedPieces = [...pieces].sort((a, b) => a.position - b.position);

  return (
    <div className="ws">
      <header className="ws-top">
        <Link to="/" className="btn ghost icon" aria-label="Back to plans">
          <ChevronLeft />
        </Link>
        {!mobile && (
          <Link to="/" className="topbar-logo" aria-label="Planifold">
            <Logo compact />
          </Link>
        )}
        <div className="ws-title">
          {renaming ? (
            <input
              className="input"
              defaultValue={plan.title}
              autoFocus
              aria-label="Plan title"
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v && v !== plan.title) void updatePlan({ title: v });
                setRenaming(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") setRenaming(false);
              }}
            />
          ) : (
            <button className="ws-title-btn" onClick={() => setRenaming(true)} title="Rename plan">
              {plan.title}
            </button>
          )}
          {!mobile && <span className={`pill ${readiness.cls}`}>{readiness.label}</span>}
        </div>
        <div className="segmented ws-views" role="tablist" aria-label="View">
          {VIEWS.map((v) => (
            <button key={v.id} role="tab" aria-selected={view === v.id} onClick={() => setView(v.id)} title={v.label}>
              <v.icon /> <span className="hide-mobile">{v.label}</span>
            </button>
          ))}
        </div>
        {saving > 0 && <span className="tiny muted hide-mobile">Saving…</span>}
        {mobile && (
          <button className="btn ghost icon" aria-label="Plan overview" onClick={() => setPlanSheetOpen(true)}>
            <Menu />
          </button>
        )}
        <button ref={menuBtn} className="btn ghost icon" aria-label="Plan options" onClick={() => setMenuOpen(true)}>
          <More />
        </button>
        {menuOpen && (
          <Popover anchor={menuBtn.current} onClose={() => setMenuOpen(false)} label="Plan options" width={240}>
            <div className="menu-list" role="menu">
              <button
                className="menu-item"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  setRenaming(true);
                }}
              >
                Rename plan
              </button>
              <button
                className="menu-item danger"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  setConfirmDelete(true);
                }}
              >
                <Trash /> Delete plan
              </button>
            </div>
          </Popover>
        )}
      </header>

      {confirmDelete && (
        <div className="notice danger" style={{ margin: "8px 12px 0" }}>
          <Confirm question={`Delete “${plan.title}” and all its pieces?`} onConfirm={() => void deletePlan()} onCancel={() => setConfirmDelete(false)} />
        </div>
      )}

      <div className={`ws-body view-${view}`}>
        {!mobile && (
          <aside className="ws-rail">
            <Rail />
          </aside>
        )}
        <section className="ws-main">
          {mobile && view === "pieces" && orderedPieces.length > 0 && (
            <div className="piece-strip" role="tablist" aria-label="Pieces">
              {orderedPieces.map((p, i) => {
                const s = analysis.sentences[p.id]!;
                return (
                  <button key={p.id} role="tab" aria-selected={focusId === p.id} className={`piece-chip kind-${p.kind}${focusId === p.id ? " active" : ""}`} onClick={() => focus(p.id)}>
                    <span className={`status-dot ${s.status}`} />
                    <span>
                      {i + 1} · {s.label}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          {view === "pieces" && <FocusCard />}
          {view === "map" && <MapView />}
          {view === "handoff" && <HandoffView />}
        </section>
        {!mobile && (
          <aside className="ws-helper">
            <HelperPanel />
          </aside>
        )}
      </div>

      {mobile && (
        <>
          <button className="helper-fab" onClick={() => setHelperOpen(true)} aria-label="Open Plani">
            <Sparkles /> Plani
          </button>
          {helperOpen && (
            <Popover anchor={null} onClose={() => setHelperOpen(false)} label="Plani" sheet>
              <div className="sheet-helper">
                <HelperPanel onClose={() => setHelperOpen(false)} />
              </div>
            </Popover>
          )}
          {planSheetOpen && (
            <Popover anchor={null} onClose={() => setPlanSheetOpen(false)} label="Plan overview" sheet title={<span style={{ fontWeight: 600 }}>{plan.title}</span>}>
              <div className="sheet-rail">
                <Rail />
              </div>
            </Popover>
          )}
        </>
      )}
    </div>
  );
}
