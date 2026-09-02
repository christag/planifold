import { useEffect, useState, type FormEvent } from "react";
import { api } from "../lib/api.js";
import { dateTime } from "../lib/format.js";
import { errorMessage, useApp } from "../lib/store.js";
import type { Provider } from "../lib/types.js";
import { Check, Trash } from "../ui/icons.js";
import { Confirm, Spinner } from "../ui/primitives.js";

const KINDS: Array<{ id: Provider["kind"]; label: string; hint: string; models: string[]; needsKey: boolean }> = [
  { id: "anthropic", label: "Anthropic (Claude)", hint: "Claude models through the Anthropic API.", models: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"], needsKey: true },
  { id: "openai", label: "OpenAI (ChatGPT)", hint: "GPT models through the OpenAI Responses API.", models: ["gpt-5.6", "gpt-5", "gpt-4.1"], needsKey: true },
  { id: "openai_compatible", label: "OpenAI-compatible server", hint: "A gateway, proxy, or self-hosted model that speaks the OpenAI chat format (Azure via a gateway, vLLM, Ollama, LiteLLM).", models: [], needsKey: false },
];

export function AiAdmin() {
  const toast = useApp((s) => s.toast);
  const refreshHelperStatus = useApp((s) => s.refreshHelperStatus);
  const [providers, setProviders] = useState<Provider[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ kind: "anthropic" as Provider["kind"], label: "", model: "claude-opus-5", apiKey: "", baseUrl: "" });
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [newKey, setNewKey] = useState("");

  const reload = () =>
    api.admin.providers
      .list()
      .then((r) => setProviders(r.providers))
      .catch((e) => toast(errorMessage(e), "danger"));
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const kind = KINDS.find((k) => k.id === form.kind)!;

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy("create");
    try {
      await api.admin.providers.create({ kind: form.kind, label: form.label.trim() || kind.label, model: form.model.trim(), apiKey: form.apiKey || undefined, baseUrl: form.baseUrl.trim() || null });
      setAdding(false);
      setForm({ kind: "anthropic", label: "", model: "claude-opus-5", apiKey: "", baseUrl: "" });
      await reload();
      await refreshHelperStatus();
      toast("Provider added. Run a test to confirm the key works.");
    } catch (err) {
      toast(errorMessage(err), "danger");
    } finally {
      setBusy(null);
    }
  }

  const act = async (id: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(id);
    try {
      await fn();
      await reload();
      await refreshHelperStatus();
      if (done) toast(done);
    } catch (err) {
      toast(errorMessage(err), "danger");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="stack lg">
      <div className="spread">
        <div>
          <h1>AI</h1>
          <p className="muted small">The model behind the helper. Keys are encrypted at rest and never shown again.</p>
        </div>
        <button className="btn primary" onClick={() => setAdding(true)}>
          Add a provider
        </button>
      </div>

      {adding && (
        <form className="card pad stack" onSubmit={create}>
          <h2>New provider</h2>
          <div className="field">
            <label htmlFor="kind">Kind</label>
            <select
              id="kind"
              className="select"
              value={form.kind}
              onChange={(e) => {
                const k = KINDS.find((x) => x.id === e.target.value)!;
                setForm({ ...form, kind: k.id, model: k.models[0] ?? "" });
              }}
            >
              {KINDS.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label}
                </option>
              ))}
            </select>
            <span className="hint">{kind.hint}</span>
          </div>
          <div className="field">
            <label htmlFor="label">Label</label>
            <input id="label" className="input" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder={kind.label} />
          </div>
          <div className="field">
            <label htmlFor="model">Model id</label>
            <input id="model" className="input mono" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} list="models" required placeholder={form.kind === "openai_compatible" ? "the model name your server expects" : ""} />
            <datalist id="models">
              {kind.models.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            {kind.models.length > 0 && <span className="hint">Suggested: {kind.models.join(", ")}. Any model id the provider accepts works.</span>}
          </div>
          <div className="field">
            <label htmlFor="key">API key{kind.needsKey ? "" : " (optional)"}</label>
            <input id="key" className="input mono" type="password" autoComplete="off" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} required={kind.needsKey} />
          </div>
          <div className="field">
            <label htmlFor="base">Base URL{form.kind === "openai_compatible" ? "" : " (optional)"}</label>
            <input id="base" className="input mono" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder={form.kind === "openai_compatible" ? "https://gateway.example.com/v1" : "Leave blank for the provider's own endpoint"} required={form.kind === "openai_compatible"} />
            <span className="hint">Point this at an internal gateway or proxy if your network requires one.</span>
          </div>
          <div className="row">
            <button className="btn primary" disabled={busy === "create"}>
              {busy === "create" ? "Adding…" : "Add provider"}
            </button>
            <button type="button" className="btn ghost" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {!providers ? (
        <Spinner label="Loading" />
      ) : providers.length === 0 ? (
        <div className="card">
          <div className="empty">
            <h3>No provider yet</h3>
            <p className="small">The helper is running on rules alone. Add Claude or ChatGPT to get suggestions written for each plan.</p>
          </div>
        </div>
      ) : (
        <div className="stack">
          {providers.map((p) => (
            <div key={p.id} className={`card pad provider${p.isActive ? " active" : ""}`}>
              <div className="spread wrap">
                <div className="grow">
                  <div className="row wrap">
                    <span style={{ fontWeight: 600 }}>{p.label}</span>
                    <span className="pill">{KINDS.find((k) => k.id === p.kind)?.label ?? p.kind}</span>
                    {p.isActive && (
                      <span className="pill ok">
                        <Check /> active
                      </span>
                    )}
                  </div>
                  <div className="small muted mono" style={{ marginTop: 4 }}>
                    {p.model}
                    {p.baseUrl ? ` · ${p.baseUrl}` : ""}
                    {p.hasKey ? ` · key ${p.keyHint}` : " · no key"}
                  </div>
                  {p.lastTestAt && (
                    <div className={`tiny ${p.lastTestOk ? "muted" : ""}`} style={{ marginTop: 4, color: p.lastTestOk ? undefined : "var(--danger)" }}>
                      Tested {dateTime(p.lastTestAt)}: {p.lastTestMessage}
                    </div>
                  )}
                </div>
                <div className="row wrap">
                  <button className="btn sm" disabled={busy === p.id} onClick={() => act(p.id, () => api.admin.providers.test(p.id))}>
                    {busy === p.id ? "Testing…" : "Test"}
                  </button>
                  {!p.isActive && (
                    <button className="btn sm" disabled={busy === p.id} onClick={() => act(p.id, () => api.admin.providers.activate(p.id), `${p.label} is now the active model.`)}>
                      Make active
                    </button>
                  )}
                  <button className="btn sm" onClick={() => setEditingKey(editingKey === p.id ? null : p.id)}>
                    Replace key
                  </button>
                  {confirm === p.id ? (
                    <Confirm question="Remove this provider?" confirmLabel="Remove" onConfirm={() => act(p.id, () => api.admin.providers.remove(p.id), "Provider removed.")} onCancel={() => setConfirm(null)} />
                  ) : (
                    <button className="btn ghost icon sm" aria-label="Remove" onClick={() => setConfirm(p.id)}>
                      <Trash />
                    </button>
                  )}
                </div>
              </div>
              {editingKey === p.id && (
                <form
                  className="row"
                  style={{ marginTop: 12 }}
                  onSubmit={(e) => {
                    e.preventDefault();
                    void act(p.id, () => api.admin.providers.update(p.id, { apiKey: newKey }), "Key replaced.").then(() => {
                      setEditingKey(null);
                      setNewKey("");
                    });
                  }}
                >
                  <input className="input mono" type="password" autoComplete="off" value={newKey} onChange={(e) => setNewKey(e.target.value)} placeholder="New API key" aria-label="New API key" required />
                  <button className="btn primary sm" disabled={busy === p.id}>
                    Save key
                  </button>
                </form>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
