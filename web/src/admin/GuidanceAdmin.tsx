import { useEffect, useState, type FormEvent } from "react";
import { api } from "../lib/api.js";
import { errorMessage, useApp } from "../lib/store.js";
import type { OrgSettings } from "../lib/types.js";
import { Spinner } from "../ui/primitives.js";

export function GuidanceAdmin() {
  const toast = useApp((s) => s.toast);
  const [form, setForm] = useState<OrgSettings | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.admin
      .overview()
      .then((o) => setForm(o.settings))
      .catch((e) => toast(errorMessage(e), "danger"));
  }, [toast]);
  if (!form) return <Spinner label="Loading" />;

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api.admin.settings(form!);
      setForm(r.settings);
      useApp.setState((s) => ({ authConfig: s.authConfig ? { ...s.authConfig, orgName: r.settings.orgName } : s.authConfig }));
      toast("Guidance saved.");
    } catch (err) {
      toast(errorMessage(err), "danger");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack lg" onSubmit={save} style={{ maxWidth: 720 }}>
      <div>
        <h1>Guidance</h1>
        <p className="muted small">What the helper is told about your organization, and what every handoff carries.</p>
      </div>
      <div className="card pad stack lg">
        <div className="field">
          <label htmlFor="org">Organization name</label>
          <input id="org" className="input" value={form.orgName} onChange={(e) => setForm({ ...form, orgName: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="builder">Preferred way to build automations</label>
          <input id="builder" className="input" value={form.preferredBuilder} onChange={(e) => setForm({ ...form, preferredBuilder: e.target.value })} placeholder="e.g. Claude Routines for most tasks; n8n only for high-volume pipelines" />
          <span className="hint">The helper steers people here when they ask how something will be built, and the build brief recommends it.</span>
        </div>
        <div className="field">
          <label htmlFor="guidance">Organization guidance</label>
          <textarea
            id="guidance"
            className="textarea"
            rows={8}
            value={form.orgGuidance}
            onChange={(e) => setForm({ ...form, orgGuidance: e.target.value })}
            placeholder={"Plain sentences the helper should follow. For example:\n\n- Never send email to customers without a person reviewing a draft first.\n- Anything touching HR data needs sign-off from People Ops.\n- Prefer reading from the data warehouse over hitting production APIs."}
          />
          <span className="hint">Goes into the helper's instructions on every request and is printed under “How this should be built” on every handoff.</span>
        </div>
        <div>
          <button className="btn primary" disabled={busy}>
            {busy ? "Saving…" : "Save guidance"}
          </button>
        </div>
      </div>
    </form>
  );
}
