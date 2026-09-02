import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api.js";
import { errorMessage, useApp } from "../lib/store.js";
import type { Overview } from "../lib/types.js";
import { Spinner } from "../ui/primitives.js";

export function OverviewAdmin() {
  const toast = useApp((s) => s.toast);
  const [data, setData] = useState<Overview | null>(null);
  useEffect(() => {
    api.admin
      .overview()
      .then(setData)
      .catch((e) => toast(errorMessage(e), "danger"));
  }, [toast]);
  if (!data) return <Spinner label="Loading" />;
  const todo: Array<{ text: string; to: string }> = [];
  if (!data.helper.configured) todo.push({ text: "Add an AI model so the helper can write suggestions.", to: "/admin/ai" });
  if (!data.settings.preferredBuilder) todo.push({ text: "Say which platform automations should be built on.", to: "/admin/guidance" });
  if (data.users < 2) todo.push({ text: "Invite the first people.", to: "/admin/users" });
  return (
    <div className="stack lg">
      <h1>Overview</h1>
      <div className="stat-grid">
        <Stat label="People" value={data.users} sub={`${data.admins} admin${data.admins === 1 ? "" : "s"}`} />
        <Stat label="Plans" value={data.plans} />
        <Stat label="Integrations on" value={data.integrationsEnabled} sub={`${data.pluginsLoaded} plugins loaded`} />
        <Stat label="Transformations" value={data.operationsEnabled} />
      </div>
      <div className="card pad stack">
        <h2>AI helper</h2>
        {data.helper.configured ? (
          <p className="small">
            Using <strong>{data.helper.provider?.label}</strong> ({data.helper.provider?.model}). <Link to="/admin/ai">Change</Link>
          </p>
        ) : (
          <p className="small muted">No model configured. The helper still works from the plan's own rules, but it can't write suggestions tailored to a thought.</p>
        )}
      </div>
      {todo.length > 0 && (
        <div className="card pad stack">
          <h2>Worth doing</h2>
          <ul className="todo">
            {todo.map((t) => (
              <li key={t.to}>
                <Link to={t.to}>{t.text}</Link>
              </li>
            ))}
          </ul>
        </div>
      )}
      {data.pluginProblems.length > 0 && (
        <div className="notice warn">
          <strong>{data.pluginProblems.length} plugin{data.pluginProblems.length === 1 ? "" : "s"} could not be loaded.</strong>
          <ul className="small">
            {data.pluginProblems.map((p) => (
              <li key={p.dir}>
                <code>{p.dir}</code>: {p.errors.join("; ")}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: number; sub?: string }) {
  return (
    <div className="card pad stat">
      <div className="stat-value serif">{value}</div>
      <div className="small muted">{label}</div>
      {sub && <div className="tiny faint">{sub}</div>}
    </div>
  );
}
