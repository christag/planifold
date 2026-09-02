import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api.js";
import { errorMessage, useApp } from "../lib/store.js";
import { Shell } from "../ui/Shell.js";
import { ArrowRight } from "../ui/icons.js";

const EXAMPLES = [
  "I want to take my emails about pasta and send them to all my friends.",
  "Every Monday, tell me which Jira tickets went stale last week.",
  "When a new hire starts in Workday, post a welcome in the team channel.",
  "Turn last month's support tickets into a one-page summary for leadership.",
];

export function NewPlanPage() {
  const navigate = useNavigate();
  const toast = useApp((s) => s.toast);
  const [thought, setThought] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!thought.trim()) return;
    setBusy(true);
    try {
      const { plan } = await api.plans.create({ thought: thought.trim() });
      navigate(`/plans/${plan.id}`, { state: { fresh: true } });
    } catch (err) {
      toast(errorMessage(err), "danger");
      setBusy(false);
    }
  }

  return (
    <Shell>
      <form onSubmit={submit} className="thought-page">
        <div className="eyebrow">The thought</div>
        <h1 className="thought-title">Say what you want to happen, the way you'd say it to a coworker.</h1>
        <p className="muted">Don't tidy it up. The messy version has the details a builder needs; the next screen turns it into pieces.</p>
        <textarea
          className="thought-input serif"
          value={thought}
          onChange={(e) => setThought(e.target.value)}
          placeholder="I want to…"
          rows={4}
          autoFocus
          maxLength={4000}
          aria-label="Your thought"
        />
        <div className="row wrap" style={{ gap: 6 }}>
          <span className="tiny muted">Try:</span>
          {EXAMPLES.map((ex) => (
            <button type="button" key={ex} className="example-chip" onClick={() => setThought(ex)}>
              {ex}
            </button>
          ))}
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn primary lg" disabled={busy || !thought.trim()}>
            {busy ? "Starting…" : "Break it into pieces"} <ArrowRight />
          </button>
          <span className="small muted">You'll fill in one piece at a time. The helper follows along.</span>
        </div>
      </form>
    </Shell>
  );
}
