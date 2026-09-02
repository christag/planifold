import { useState, type FormEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { api } from "../lib/api.js";
import { errorMessage, useApp } from "../lib/store.js";
import { Logo } from "../ui/primitives.js";

export function LoginPage() {
  const user = useApp((s) => s.user);
  const authConfig = useApp((s) => s.authConfig);
  const setUser = useApp((s) => s.setUser);
  const navigate = useNavigate();
  const loc = useLocation();
  const params = new URLSearchParams(loc.search);
  const next = params.get("next") && params.get("next")!.startsWith("/") ? params.get("next")! : "/";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(params.get("error"));
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to={next} replace />;
  if (authConfig?.needsSetup) return <Navigate to="/setup" replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { user } = await api.auth.login(email, password);
      setUser(user);
      navigate(next, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card card">
        <div className="auth-head">
          <Logo />
          {authConfig?.orgName && <div className="muted small">{authConfig.orgName}</div>}
        </div>
        <p className="auth-tagline serif">Turn a big thought into pieces an AI can build.</p>
        {error && (
          <div className="notice danger" role="alert">
            {error}
          </div>
        )}
        {authConfig?.oidc && (
          <a className="btn primary lg" href={`/api/auth/oidc/start?redirect=${encodeURIComponent(next)}`}>
            {authConfig.oidc.label}
          </a>
        )}
        {authConfig?.oidc && authConfig.local && <div className="auth-or">or with a password</div>}
        {authConfig?.local && (
          <form onSubmit={submit} className="stack">
            <div className="field">
              <label htmlFor="email">Email</label>
              <input id="email" className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus={!authConfig.oidc} />
            </div>
            <div className="field">
              <label htmlFor="password">Password</label>
              <input id="password" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </div>
            <button className={`btn ${authConfig.oidc ? "" : "primary"} lg`} disabled={busy}>
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </form>
        )}
        {!authConfig?.local && !authConfig?.oidc && (
          <p className="small muted">Sign-in is handled by your network. If you're seeing this, ask your administrator to check the authentication settings.</p>
        )}
      </div>
    </div>
  );
}
