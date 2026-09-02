import { useState, type FormEvent } from "react";
import { api } from "../lib/api.js";
import { authSourceLabel, ROLE_LABEL } from "../lib/format.js";
import { errorMessage, useApp, type Theme } from "../lib/store.js";
import { Shell } from "../ui/Shell.js";
import { Logo } from "../ui/primitives.js";

function PasswordForm({ forced = false, onDone }: { forced?: boolean; onDone?: () => void }) {
  const toast = useApp((s) => s.toast);
  const user = useApp((s) => s.user)!;
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (next !== again) return setError("The two new passwords don't match.");
    setBusy(true);
    setError(null);
    try {
      await api.auth.changePassword({ currentPassword: forced ? undefined : current, newPassword: next });
      useApp.setState({ user: { ...user, mustChangePassword: false } });
      toast("Password changed.");
      setCurrent("");
      setNext("");
      setAgain("");
      onDone?.();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="stack">
      {error && (
        <div className="notice danger" role="alert">
          {error}
        </div>
      )}
      {!forced && (
        <div className="field">
          <label htmlFor="cur">Current password</label>
          <input id="cur" className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
        </div>
      )}
      <div className="field">
        <label htmlFor="new">New password</label>
        <input id="new" className="input" type="password" autoComplete="new-password" minLength={10} value={next} onChange={(e) => setNext(e.target.value)} required autoFocus={forced} />
        <span className="hint">At least 10 characters.</span>
      </div>
      <div className="field">
        <label htmlFor="again">New password, again</label>
        <input id="again" className="input" type="password" autoComplete="new-password" minLength={10} value={again} onChange={(e) => setAgain(e.target.value)} required />
      </div>
      <div>
        <button className="btn primary" disabled={busy}>
          {busy ? "Saving…" : "Change password"}
        </button>
      </div>
    </form>
  );
}

/** Shown instead of the app until a temporary password is replaced. */
export function ChangePasswordGate() {
  const user = useApp((s) => s.user)!;
  const logout = useApp((s) => s.logout);
  return (
    <div className="auth-page">
      <div className="auth-card card">
        <div className="auth-head">
          <Logo />
        </div>
        <h1>Choose your own password</h1>
        <p className="muted small">
          You're signed in as {user.email} with a temporary password. Pick a new one to continue.
        </p>
        <PasswordForm forced />
        <button className="btn ghost sm" onClick={() => void logout()}>
          Sign out instead
        </button>
      </div>
    </div>
  );
}

export function AccountPage() {
  const user = useApp((s) => s.user)!;
  const theme = useApp((s) => s.theme);
  const setTheme = useApp((s) => s.setTheme);
  return (
    <Shell>
      <div className="page narrow" style={{ padding: 0 }}>
        <h1>Account</h1>
        <div className="stack lg" style={{ marginTop: 16 }}>
          <section className="card pad stack">
            <h2>You</h2>
            <dl className="dl">
              <dt>Name</dt>
              <dd>{user.name}</dd>
              <dt>Email</dt>
              <dd>{user.email}</dd>
              <dt>Role</dt>
              <dd>{ROLE_LABEL[user.role]}</dd>
              <dt>Signs in with</dt>
              <dd>{user.authSource === "local" ? "a password" : authSourceLabel(user.authSource)}</dd>
            </dl>
          </section>
          <section className="card pad stack">
            <h2>Appearance</h2>
            <div className="segmented" role="tablist" aria-label="Theme">
              {(["system", "light", "dark"] as Theme[]).map((t) => (
                <button key={t} role="tab" aria-selected={theme === t} onClick={() => setTheme(t)}>
                  {t === "system" ? "Match system" : t === "light" ? "Light" : "Dark"}
                </button>
              ))}
            </div>
          </section>
          {user.authSource === "local" && (
            <section className="card pad stack">
              <h2>Password</h2>
              <PasswordForm />
            </section>
          )}
        </div>
      </div>
    </Shell>
  );
}
