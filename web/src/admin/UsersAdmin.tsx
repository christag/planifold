import { useEffect, useState, type FormEvent } from "react";
import { api } from "../lib/api.js";
import { relativeTime, ROLE_LABEL } from "../lib/format.js";
import { errorMessage, useApp } from "../lib/store.js";
import type { User } from "../lib/types.js";
import { Confirm, Spinner } from "../ui/primitives.js";

const ROLES: User["role"][] = ["user", "integration_admin", "app_admin"];

export function UsersAdmin() {
  const toast = useApp((s) => s.toast);
  const me = useApp((s) => s.user)!;
  const [users, setUsers] = useState<User[] | null>(null);
  const [form, setForm] = useState({ email: "", name: "", role: "user" as User["role"] });
  const [reveal, setReveal] = useState<{ email: string; password: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);

  const reload = () =>
    api.admin.users
      .list()
      .then((r) => setUsers(r.users))
      .catch((e) => toast(errorMessage(e), "danger"));
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy("create");
    try {
      const r = await api.admin.users.create(form);
      setReveal({ email: r.user.email, password: r.temporaryPassword });
      setForm({ email: "", name: "", role: "user" });
      await reload();
    } catch (err) {
      toast(errorMessage(err), "danger");
    } finally {
      setBusy(null);
    }
  }

  const update = async (id: string, patch: Parameters<typeof api.admin.users.update>[1]) => {
    setBusy(id);
    try {
      const r = await api.admin.users.update(id, patch);
      if (r.temporaryPassword) setReveal({ email: r.user.email, password: r.temporaryPassword });
      await reload();
    } catch (err) {
      toast(errorMessage(err), "danger");
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: string) => {
    setBusy(id);
    try {
      await api.admin.users.remove(id);
      setConfirm(null);
      await reload();
      toast("User deleted.");
    } catch (err) {
      toast(errorMessage(err), "danger");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="stack lg">
      <div>
        <h1>Users</h1>
        <p className="muted small">Users plan. Integration admins also own systems. App admins run this app.</p>
      </div>

      {reveal && (
        <div className="notice ok stack" role="status">
          <div>
            <strong>Temporary password for {reveal.email}</strong>
          </div>
          <code className="reveal">{reveal.password}</code>
          <div className="small">Share it privately. It is shown once and must be changed at first sign-in.</div>
          <div>
            <button className="btn sm" onClick={() => setReveal(null)}>
              Done
            </button>
          </div>
        </div>
      )}

      <form className="card pad" onSubmit={create}>
        <div className="row wrap" style={{ alignItems: "flex-end" }}>
          <div className="field grow">
            <label htmlFor="u-name">Name</label>
            <input id="u-name" className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          </div>
          <div className="field grow">
            <label htmlFor="u-email">Email</label>
            <input id="u-email" className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
          </div>
          <div className="field">
            <label htmlFor="u-role">Role</label>
            <select id="u-role" className="select" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as User["role"] })}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </select>
          </div>
          <button className="btn primary" disabled={busy === "create"}>
            {busy === "create" ? "Adding…" : "Add person"}
          </button>
        </div>
      </form>

      {!users ? (
        <Spinner label="Loading" />
      ) : (
        <div className="card table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Person</th>
                <th>Role</th>
                <th>Signs in</th>
                <th>Last seen</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} style={{ opacity: u.disabled ? 0.55 : 1 }}>
                  <td>
                    <div style={{ fontWeight: 500 }}>
                      {u.name} {u.id === me.id && <span className="tiny muted">(you)</span>}
                    </div>
                    <div className="tiny muted">{u.email}</div>
                  </td>
                  <td>
                    <select className="select" value={u.role} disabled={u.id === me.id || busy === u.id} onChange={(e) => update(u.id, { role: e.target.value as User["role"] })} aria-label={`Role for ${u.name}`}>
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABEL[r]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="small muted">
                    {u.authSource === "local" ? "password" : u.authSource === "oidc" ? "SSO" : "network"}
                    {u.mustChangePassword && <span className="pill warn" style={{ marginLeft: 6 }}>temp password</span>}
                    {u.disabled && <span className="pill danger" style={{ marginLeft: 6 }}>disabled</span>}
                  </td>
                  <td className="small muted">{relativeTime(u.lastLoginAt)}</td>
                  <td>
                    {u.id !== me.id && (
                      <div className="row wrap" style={{ justifyContent: "flex-end" }}>
                        {confirm === u.id ? (
                          <Confirm question={`Delete ${u.name}? Their plans go too.`} onConfirm={() => remove(u.id)} onCancel={() => setConfirm(null)} />
                        ) : (
                          <>
                            {u.authSource === "local" && (
                              <button className="btn sm" disabled={busy === u.id} onClick={() => update(u.id, { resetPassword: true })}>
                                Reset password
                              </button>
                            )}
                            <button className="btn sm" disabled={busy === u.id} onClick={() => update(u.id, { disabled: !u.disabled })}>
                              {u.disabled ? "Enable" : "Disable"}
                            </button>
                            <button className="btn sm ghost danger" onClick={() => setConfirm(u.id)}>
                              Delete
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
