import { useEffect, useState } from "react";
import { PluginEditor } from "../admin/PluginEditor.js";
import { api } from "../lib/api.js";
import { errorMessage, useApp } from "../lib/store.js";
import type { PluginInfo } from "../lib/types.js";
import { Shell } from "../ui/Shell.js";
import { EmptyState, Spinner } from "../ui/primitives.js";

/** What an integration administrator sees: the systems they own, and nothing else. */
export function IntegrationsPage() {
  const user = useApp((s) => s.user)!;
  const toast = useApp((s) => s.toast);
  const loadCatalog = useApp((s) => s.loadCatalog);
  const [plugins, setPlugins] = useState<PluginInfo[] | null>(null);

  useEffect(() => {
    api.integrations
      .list()
      .then((r) => setPlugins(r.plugins))
      .catch((e) => toast(errorMessage(e), "danger"));
  }, [toast]);

  const save = (id: string) => async (patch: Parameters<typeof api.integrations.update>[1]) => {
    const { plugin } = await api.integrations.update(id, patch);
    setPlugins((ps) => (ps ? ps.map((p) => (p.id === id ? plugin : p)) : ps));
    void loadCatalog();
  };

  return (
    <Shell>
      <h1>Integrations</h1>
      <p className="muted small" style={{ marginBottom: 20 }}>
        {user.role === "app_admin" ? "All loaded plugins. Enable, assign owners, and set guidance under Admin." : "The systems you own. What you write here guides the helper and lands on every handoff that touches them."}
      </p>
      {!plugins ? (
        <Spinner label="Loading" />
      ) : plugins.length === 0 ? (
        <div className="card">
          <EmptyState title="No integrations assigned to you">Ask an app administrator to make you the owner of the systems you look after.</EmptyState>
        </div>
      ) : (
        <div className="stack">
          {plugins.map((p) => (
            <PluginEditor key={p.id} plugin={p} admin={false} onSave={save(p.id)} />
          ))}
        </div>
      )}
    </Shell>
  );
}
