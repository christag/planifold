import { useEffect, type ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AdminRoutes } from "./admin/AdminRoutes.js";
import { setUnauthorizedHandler } from "./lib/api.js";
import { useApp } from "./lib/store.js";
import { AccountPage, ChangePasswordGate } from "./pages/AccountPage.js";
import { IntegrationsPage } from "./pages/IntegrationsPage.js";
import { LoginPage } from "./pages/LoginPage.js";
import { NewPlanPage } from "./pages/NewPlanPage.js";
import { NotFoundPage } from "./pages/NotFoundPage.js";
import { PlansPage } from "./pages/PlansPage.js";
import { SetupPage } from "./pages/SetupPage.js";
import { PlanPage } from "./workspace/PlanPage.js";
import { Logo, Toasts } from "./ui/primitives.js";

function Splash() {
  return (
    <div className="splash">
      <Logo />
    </div>
  );
}

function RequireAuth({ children }: { children: ReactNode }) {
  const user = useApp((s) => s.user);
  const authConfig = useApp((s) => s.authConfig);
  const loc = useLocation();
  if (!user) {
    if (authConfig?.needsSetup) return <Navigate to="/setup" replace />;
    return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  }
  if (user.mustChangePassword) return <ChangePasswordGate />;
  return <>{children}</>;
}

function RequireRole({ role, children }: { role: "app_admin" | "integration_admin"; children: ReactNode }) {
  const user = useApp((s) => s.user);
  const ok = user && (user.role === "app_admin" || (role === "integration_admin" && user.role === "integration_admin"));
  if (!ok) return <Navigate to="/" replace />;
  return <>{children}</>;
}

export default function App() {
  const booted = useApp((s) => s.booted);
  const boot = useApp((s) => s.boot);
  useEffect(() => {
    setUnauthorizedHandler(() => useApp.setState({ user: null }));
    void boot();
  }, [boot]);
  if (!booted) return <Splash />;
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/setup" element={<SetupPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/"
          element={
            <RequireAuth>
              <PlansPage />
            </RequireAuth>
          }
        />
        <Route
          path="/new"
          element={
            <RequireAuth>
              <NewPlanPage />
            </RequireAuth>
          }
        />
        <Route
          path="/plans/:id"
          element={
            <RequireAuth>
              <PlanPage />
            </RequireAuth>
          }
        />
        <Route
          path="/integrations"
          element={
            <RequireAuth>
              <RequireRole role="integration_admin">
                <IntegrationsPage />
              </RequireRole>
            </RequireAuth>
          }
        />
        <Route
          path="/account"
          element={
            <RequireAuth>
              <AccountPage />
            </RequireAuth>
          }
        />
        <Route
          path="/admin/*"
          element={
            <RequireAuth>
              <RequireRole role="app_admin">
                <AdminRoutes />
              </RequireRole>
            </RequireAuth>
          }
        />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
      <Toasts />
    </BrowserRouter>
  );
}
