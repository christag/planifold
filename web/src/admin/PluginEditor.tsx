import { useState } from "react";
import { Markdown } from "../lib/markdown.js";
import { errorMessage, useApp } from "../lib/store.js";
import type { PluginInfo, User } from "../lib/types.js";
import { ExternalLink } from "../ui/icons.js";

interface Props {
  plugin: PluginInfo;
  /** App admins can enable and assign; integration admins only describe. */
  admin: boolean;
  users?: User[];
  onSave(patch: { enabled?: boolean; ownerId?: string | null; guidance?: string | null; setupNotes?: string | null; overrides?: PluginInfo["overrides"] }): Promise<void>;
}

/** Everything an owner can say about one integration: guidance for the helper, how to get access, what to hide. */
export function PluginEditor({ plugin, admin, users = [], onSave }: Props) {
  const toast = useApp((s) => s.toast);
  const [open, setOpen] = useState(false);
  const [guidance, setGuidance] = useState(plugin.guidance ?? "");
  const [setup, setSetup] = useState(plugin.setupNotes ?? "");
  const [overrides, setOverrides] = useState(plugin.overrides);
  const [busy, setBusy] = useState(false);
  const [readme, setReadme] = useState(false);
  const isTransforms = plugin.kind === "transforms";

  const toggleList = (key: "disabledObjects" | "disabledActions" | "disabledOperations", id: string) => {
    const cur = new Set(overrides[key] ?? []);
    if (cur.has(id)) cur.delete(id);
    else cur.add(id);
    setOverrides({ ...overrides, [key]: [...cur] });
  };

  const save = async () => {
    setBusy(true);
    try {
      await onSave({ guidance: guidance.trim() || null, setupNotes: setup.trim() || null, overrides });
      toast("Saved.");
      setOpen(false);
    } catch (e) {
      toast(errorMessage(e), "danger");
    } finally {
      setBusy(false);
    }
  };

  const dirty = guidance !== (plugin.guidance ?? "") || setup !== (plugin.setupNotes ?? "") || JSON.stringify(overrides) !== JSON.stringify(plugin.overrides);

  return (
    <div className={`card plugin-card${plugin.enabled ? "" : " disabled"}`}>
      <div className="plugin-head">
        <span className="plugin-icon" aria-hidden>
          {plugin.icon ?? plugin.name.slice(0, 1)}
        </span>
        <div className="grow">
          <div className="row wrap">
            <span style={{ fontWeight: 600 }}>{plugin.name}</span>
            <span className="tiny muted">v{plugin.version}</span>
            {plugin.source === "installed" && <span className="pill">installed</span>}
            {!plugin.enabled && <span className="pill warn">off</span>}
            {plugin.roles.map((r) => (
              <span key={r} className={`pill kind kind-${r}`}>
                {r}
              </span>
            ))}
            {isTransforms && <span className="pill kind kind-transform">transformations</span>}
          </div>
          <div className="small muted">{plugin.description}</div>
          <div className="tiny muted" style={{ marginTop: 4 }}>
            {isTransforms
              ? `${plugin.operations.length} operations`
              : `${plugin.objects.length} object${plugin.objects.length === 1 ? "" : "s"} · ${plugin.actions.length} action${plugin.actions.length === 1 ? "" : "s"}`}
            {plugin.owner ? ` · owned by ${plugin.owner.name}` : admin ? " · no owner" : ""}
            {plugin.docsUrl && (
              <>
                {" · "}
                <a href={plugin.docsUrl} target="_blank" rel="noreferrer">
                  docs <ExternalLink />
                </a>
              </>
            )}
          </div>
        </div>
        <div className="row">
          {admin && (
            <button
              role="switch"
              aria-checked={plugin.enabled}
              aria-label={`${plugin.name} enabled`}
              className="switch"
              onClick={() => onSave({ enabled: !plugin.enabled }).catch((e) => toast(errorMessage(e), "danger"))}
            />
          )}
          <button className="btn sm" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? "Close" : "Edit"}
          </button>
        </div>
      </div>

      {open && (
        <div className="plugin-body stack lg">
          {admin && (
            <div className="field">
              <label htmlFor={`owner-${plugin.id}`}>Integration owner</label>
              <select
                id={`owner-${plugin.id}`}
                className="select"
                value={plugin.owner?.id ?? ""}
                onChange={(e) => onSave({ ownerId: e.target.value || null }).catch((err) => toast(errorMessage(err), "danger"))}
              >
                <option value="">Nobody yet</option>
                {users
                  .filter((u) => u.role !== "user" && !u.disabled)
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name} ({u.email})
                    </option>
                  ))}
              </select>
              <span className="hint">Owners can edit guidance and hide objects. Only integration admins and app admins can be owners.</span>
            </div>
          )}
          <div className="field">
            <label htmlFor={`guidance-${plugin.id}`}>Guidance for the helper</label>
            <textarea id={`guidance-${plugin.id}`} className="textarea" rows={4} value={guidance} onChange={(e) => setGuidance(e.target.value)} placeholder={plugin.defaultGuidance ?? "How is this system normally used here? What should people avoid?"} />
            <span className="hint">Read by the AI helper and printed on every handoff that uses {plugin.name}. Leave blank to keep the plugin's default, shown as the placeholder.</span>
          </div>
          <div className="field">
            <label htmlFor={`setup-${plugin.id}`}>How to get access</label>
            <textarea id={`setup-${plugin.id}`} className="textarea" rows={2} value={setup} onChange={(e) => setSetup(e.target.value)} placeholder={plugin.defaultSetupNotes ?? "Who to ask, what to request, how long it takes."} />
          </div>
          {!isTransforms && plugin.objects.length > 0 && (
            <fieldset className="field">
              <legend className="label">Objects people can read</legend>
              <div className="row wrap">
                {plugin.objects.map((o) => (
                  <label key={o.id} className="checkbox small">
                    <input type="checkbox" checked={!overrides.disabledObjects?.includes(o.id)} onChange={() => toggleList("disabledObjects", o.id)} /> {o.label}
                    <span className="tiny muted">({o.fieldCount} fields)</span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          {!isTransforms && plugin.actions.length > 0 && (
            <fieldset className="field">
              <legend className="label">Actions people can plan</legend>
              <div className="row wrap">
                {plugin.actions.map((a) => (
                  <label key={a.id} className="checkbox small">
                    <input type="checkbox" checked={!overrides.disabledActions?.includes(a.id)} onChange={() => toggleList("disabledActions", a.id)} /> {a.label}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          {isTransforms && (
            <fieldset className="field">
              <legend className="label">Operations people can use</legend>
              <div className="row wrap">
                {plugin.operations.map((o) => (
                  <label key={o.id} className="checkbox small">
                    <input type="checkbox" checked={!overrides.disabledOperations?.includes(o.id)} onChange={() => toggleList("disabledOperations", o.id)} /> {o.label}
                    {o.ai && <span className="pill pen">AI</span>}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          {plugin.readme && (
            <div>
              <button className="btn ghost sm" onClick={() => setReadme(!readme)}>
                {readme ? "Hide" : "Show"} plugin README
              </button>
              {readme && <Markdown text={plugin.readme} className="small" />}
            </div>
          )}
          <div className="row">
            <button className="btn primary" onClick={save} disabled={busy || !dirty}>
              {busy ? "Saving…" : "Save changes"}
            </button>
            {dirty && (
              <button
                className="btn ghost"
                onClick={() => {
                  setGuidance(plugin.guidance ?? "");
                  setSetup(plugin.setupNotes ?? "");
                  setOverrides(plugin.overrides);
                }}
              >
                Discard
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
