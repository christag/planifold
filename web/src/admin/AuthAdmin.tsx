import { useEffect, useState, type FormEvent } from "react";
import { api } from "../lib/api.js";
import { copyText, relativeTime } from "../lib/format.js";
import { errorMessage, useApp } from "../lib/store.js";
import type { AuthAdminInfo } from "../lib/types.js";
import { Confirm, Spinner } from "../ui/primitives.js";

export function AuthAdmin() {
  const toast = useApp((s) => s.toast);
  const [info, setInfo] = useState<AuthAdminInfo | null>(null);
  const [label, setLabel] = useState("");
  const [reveal, setReveal] = useState<{ label: string; secret: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);

  const reload = () =>
    api.admin
      .auth()
      .then(setInfo)
      .catch((e) => toast(errorMessage(e), "danger"));
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function createToken(e: FormEvent) {
    e.preventDefault();
    setBusy("create");
    try {
      const r = await api.admin.scim.createToken(label.trim() || "SCIM client");
      setReveal({ label: r.token.label, secret: r.secret });
      setLabel("");
      await reload();
    } catch (err) {
      toast(errorMessage(err), "danger");
    } finally {
      setBusy(null);
    }
  }

  async function revoke(id: string) {
    setBusy(id);
    try {
      await api.admin.scim.revokeToken(id);
      setConfirm(null);
      await reload();
      toast("Token revoked. That client can no longer provision users.");
    } catch (err) {
      toast(errorMessage(err), "danger");
    } finally {
      setBusy(null);
    }
  }

  if (!info) return <Spinner label="Loading" />;
  const { methods, scim } = info;
  const saml = methods.saml;

  return (
    <div className="stack lg">
      <div>
        <h1>Sign-in</h1>
        <p className="muted small">How people get in, and how your identity provider keeps the list of people up to date. Methods are switched on with environment variables; see docs/deploy.md.</p>
      </div>

      <section className="card pad stack">
        <h2>Methods</h2>
        <dl className="dl">
          <dt>Password</dt>
          <dd>{methods.local ? "On" : saml?.enforced ? "Off (SAML is enforced)" : "Off"}</dd>
          <dt>OpenID Connect</dt>
          <dd>{methods.oidc ? `On — ${methods.oidc.issuer}` : "Off"}</dd>
          <dt>SAML</dt>
          <dd>{saml ? (saml.enforced ? "On and enforced: the only way in" : "On") : "Off"}</dd>
          <dt>Trusted header</dt>
          <dd>{methods.trustedHeader ? "On" : "Off"}</dd>
        </dl>
        {saml?.enforced && <div className="notice warn small">SAML is enforced. Password, OpenID Connect, and trusted-header sign-in are off, and only sessions that came through SAML are accepted. To get back in if the identity provider breaks, unset SAML_ENFORCE and restart.</div>}
      </section>

      {saml && (
        <section className="card pad stack">
          <h2>SAML service provider</h2>
          <p className="small muted">Give these values to whoever manages the identity provider (in Okta: the SAML app's settings).</p>
          <dl className="dl">
            <dt>Single sign-on URL (ACS)</dt>
            <dd>
              <Copyable value={saml.acsUrl} />
            </dd>
            <dt>Audience URI (SP entity id)</dt>
            <dd>
              <Copyable value={saml.entityId} />
            </dd>
            <dt>Metadata</dt>
            <dd>
              <a href={saml.metadataUrl} target="_blank" rel="noreferrer">
                {saml.metadataUrl}
              </a>
            </dd>
            <dt>Identity provider</dt>
            <dd>
              <code className="small">{saml.idpIssuer}</code>
              <div className="tiny muted">{saml.idpSsoUrl}</div>
            </dd>
            <dt>Attributes read</dt>
            <dd className="small">
              email: <code>{saml.attributes.email}</code>, name: <code>{saml.attributes.name}</code> or <code>{saml.attributes.firstName}</code> + <code>{saml.attributes.lastName}</code>, groups: <code>{saml.attributes.groups}</code>
            </dd>
            <dt>IdP-initiated sign-in</dt>
            <dd>{saml.allowIdpInitiated ? "Allowed (SAML_ALLOW_IDP_INITIATED)" : "Off: every sign-in starts here"}</dd>
          </dl>
        </section>
      )}

      <section className="card pad stack">
        <h2>SCIM provisioning</h2>
        <p className="small muted">
          Lets your identity provider create, update, deactivate, and group people here. In Okta, add a SCIM integration with this base URL and “HTTP Header” authentication, then paste a token from below as the bearer token.
        </p>
        <dl className="dl">
          <dt>SCIM base URL</dt>
          <dd>
            <Copyable value={scim.baseUrl} />
          </dd>
          <dt>Unique identifier field</dt>
          <dd>
            <code>userName</code> <span className="muted small">(the person's email address)</span>
          </dd>
        </dl>

        {reveal && (
          <div className="notice ok stack" role="status">
            <div>
              <strong>Token for {reveal.label}</strong>
            </div>
            <code className="reveal">{reveal.secret}</code>
            <div className="small">Copy it now; it is shown once. Paste it into the identity provider as the SCIM bearer token.</div>
            <div className="row">
              <button
                className="btn sm"
                onClick={async () => {
                  toast((await copyText(reveal.secret)) ? "Copied." : "Couldn't copy; select the token and copy it by hand.", "info");
                }}
              >
                Copy
              </button>
              <button className="btn sm ghost" onClick={() => setReveal(null)}>
                Done
              </button>
            </div>
          </div>
        )}

        <form onSubmit={createToken} className="row wrap" style={{ alignItems: "flex-end" }}>
          <div className="field grow">
            <label htmlFor="scim-label">New token</label>
            <input id="scim-label" className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="What will use it, e.g. Okta" maxLength={80} />
          </div>
          <button className="btn primary" disabled={busy === "create"}>
            {busy === "create" ? "Creating…" : "Create token"}
          </button>
        </form>

        {scim.tokens.length === 0 ? (
          <p className="small muted">No tokens yet. SCIM requests are refused until one exists.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Token</th>
                  <th>Created</th>
                  <th>Last used</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {scim.tokens.map((tk) => (
                  <tr key={tk.id}>
                    <td>
                      <div style={{ fontWeight: 500 }}>{tk.label}</div>
                      <code className="tiny muted">{tk.prefix}</code>
                    </td>
                    <td className="small muted">{relativeTime(tk.createdAt)}</td>
                    <td className="small muted">{relativeTime(tk.lastUsedAt)}</td>
                    <td>
                      <div className="row" style={{ justifyContent: "flex-end" }}>
                        {confirm === tk.id ? (
                          <Confirm question={`Revoke the ${tk.label} token? Provisioning from it stops at once.`} confirmLabel="Revoke" onConfirm={() => revoke(tk.id)} onCancel={() => setConfirm(null)} />
                        ) : (
                          <button className="btn sm ghost danger" disabled={busy === tk.id} onClick={() => setConfirm(tk.id)}>
                            Revoke
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card pad stack">
        <h2>Groups from the identity provider</h2>
        {scim.groups.length === 0 ? (
          <p className="small muted">None yet. Groups appear here when the identity provider pushes them over SCIM. Membership is recorded for reference; roles are still set in Users, or at first sign-in by SAML_ADMIN_GROUPS.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Group</th>
                  <th>Members</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {scim.groups.map((g) => (
                  <tr key={g.id}>
                    <td>
                      <div style={{ fontWeight: 500 }}>{g.displayName}</div>
                      {g.externalId && <code className="tiny muted">{g.externalId}</code>}
                    </td>
                    <td className="small muted">{g.members}</td>
                    <td className="small muted">{relativeTime(g.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function Copyable({ value }: { value: string }) {
  const toast = useApp((s) => s.toast);
  return (
    <span className="row wrap" style={{ gap: 6, alignItems: "center" }}>
      <code className="small" style={{ wordBreak: "break-all" }}>
        {value}
      </code>
      <button
        type="button"
        className="btn sm ghost"
        onClick={async () => {
          toast((await copyText(value)) ? "Copied." : "Couldn't copy; select it and copy by hand.", "info");
        }}
      >
        Copy
      </button>
    </span>
  );
}
