import { useEffect, useState } from "react";
import { api } from "../lib/api.js";
import { errorMessage, useApp } from "../lib/store.js";
import type { PluginInfo, PluginProblem, User } from "../lib/types.js";
import { Refresh } from "../ui/icons.js";
import { Spinner } from "../ui/primitives.js";
import { PluginEditor } from "./PluginEditor.js";

export function PluginsAdmin() {
  const toast = useApp((s) => s.toast);
  const loadCatalog = useApp((s) => s.loadCatalog);
  const [plugins, setPlugins] = useState<PluginInfo[] | null>(null);
  const [problems, setProblems] = useState<PluginProblem[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    Promise.all([api.admin.plugins.list(), api.admin.users.list()])
      .then(([p, u]) => {
        setPlugins(p.plugins);
        setProblems(p.problems);
        setUsers(u.users);
      })
      .catch((e) => toast(errorMessage(e), "danger"));
  }, [toast]);

  const save = (id: string) => async (patch: Parameters<typeof api.admin.plugins.update>[1]) => {
    const { plugin } = await api.admin.plugins.update(id, patch);
    setPlugins((ps) => (ps ? ps.map((p) => (p.id === id ? plugin : p)) : ps));
    void loadCatalog();
  };

  const reload = async () => {
    setBusy(true);
    try {
      const r = await api.admin.plugins.reload();
      setPlugins(r.plugins);
      setProblems(r.problems);
      void loadCatalog();
      toast(`Reloaded ${r.plugins.length} plugins${r.problems.length ? `, ${r.problems.length} with problems` : ""}.`);
    } catch (e) {
      toast(errorMessage(e), "danger");
    } finally {
      setBusy(false);
    }
  };

  const shown = (plugins ?? []).filter((p) => !filter || `${p.name} ${p.description} ${p.category}`.toLowerCase().includes(filter.toLowerCase()));
  const categories = [...new Set(shown.map((p) => p.category))].sort();

  return (
    <div className="stack lg">
      <div className="spread wrap">
        <div>
          <h1>Integrations</h1>
          <p className="muted small">Every plugin the server found. Turn them on, hand them to owners, and add the guidance your organization wants followed.</p>
        </div>
        <div className="row">
          <input className="input" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter plugins" style={{ width: 180 }} />
          <button className="btn" onClick={reload} disabled={busy}>
            <Refresh /> Reload from disk
          </button>
        </div>
      </div>
      <p className="tiny muted">
        To add a plugin, drop a directory with a <code>plugin.json</code> into the plugins folder (<code>PLUGINS_DIR</code>) and reload. The format is documented in <code>docs/plugins.md</code>.
      </p>
      {problems.length > 0 && (
        <div className="notice warn small">
          <strong>Skipped:</strong>
          <ul>
            {problems.map((p) => (
              <li key={p.dir}>
                <code>{p.dir}</code>: {p.errors.join("; ")}
              </li>
            ))}
          </ul>
        </div>
      )}
      {!plugins ? (
        <Spinner label="Loading" />
      ) : (
        categories.map((c) => (
          <section key={c} className="stack">
            <div className="eyebrow">{c}</div>
            {shown
              .filter((p) => p.category === c)
              .map((p) => (
                <PluginEditor key={p.id} plugin={p} admin users={users} onSave={save(p.id)} />
              ))}
          </section>
        ))
      )}
    </div>
  );
}
