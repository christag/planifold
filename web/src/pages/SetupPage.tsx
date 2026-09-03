import { useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { api } from "../lib/api.js";
import { errorMessage, useApp } from "../lib/store.js";
import { Logo } from "../ui/primitives.js";

export function SetupPage() {
  const authConfig = useApp((s) => s.authConfig);
  const setUser = useApp((s) => s.setUser);
  const navigate = useNavigate();
  const [form, setForm] = useState({ orgName: "", name: "", email: "", password: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (authConfig && !authConfig.needsSetup) return <Navigate to="/login" replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { user } = await api.auth.setup(form);
      useApp.setState({ authConfig: { ...authConfig!, needsSetup: false, orgName: form.orgName } });
      setUser(user);
      navigate("/", { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  return (
    <div className="auth-page">
      <div className="auth-card card">
        <div className="auth-head">
          <Logo />
        </div>
        <h1>Set up Planifold</h1>
        <p className="muted small">This creates the first app administrator. You can add everyone else afterwards, or connect single sign-on.</p>
        {error && (
          <div className="notice danger" role="alert">
            {error}
          </div>
        )}
        <form onSubmit={submit} className="stack">
          <div className="field">
            <label htmlFor="org">Organization name</label>
            <input id="org" className="input" value={form.orgName} onChange={set("orgName")} placeholder="Acme Corp" autoFocus />
            <span className="hint">Shown on the sign-in page and used by Plani.</span>
          </div>
          <div className="field">
            <label htmlFor="name">Your name</label>
            <input id="name" className="input" value={form.name} onChange={set("name")} required />
          </div>
          <div className="field">
            <label htmlFor="email">Email</label>
            <input id="email" className="input" type="email" autoComplete="username" value={form.email} onChange={set("email")} required />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input id="password" className="input" type="password" autoComplete="new-password" minLength={10} value={form.password} onChange={set("password")} required />
            <span className="hint">At least 10 characters.</span>
          </div>
          <button className="btn primary lg" disabled={busy}>
            {busy ? "Setting up…" : "Create administrator"}
          </button>
        </form>
      </div>
    </div>
  );
}
