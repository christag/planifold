import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { Shell } from "../ui/Shell.js";
import { Activity, Key, MessageSquare, Puzzle, Settings, Users } from "../ui/icons.js";
import { AiAdmin } from "./AiAdmin.js";
import { AuditAdmin } from "./AuditAdmin.js";
import { GuidanceAdmin } from "./GuidanceAdmin.js";
import { OverviewAdmin } from "./OverviewAdmin.js";
import { PluginsAdmin } from "./PluginsAdmin.js";
import { UsersAdmin } from "./UsersAdmin.js";

const NAV = [
  { to: "/admin", end: true, label: "Overview", icon: Settings },
  { to: "/admin/ai", label: "AI", icon: Key },
  { to: "/admin/integrations", label: "Integrations", icon: Puzzle },
  { to: "/admin/guidance", label: "Guidance", icon: MessageSquare },
  { to: "/admin/users", label: "Users", icon: Users },
  { to: "/admin/audit", label: "Audit log", icon: Activity },
];

export function AdminRoutes() {
  return (
    <Shell wide>
      <div className="admin">
        <nav className="admin-nav" aria-label="Admin sections">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className="admin-nav-link">
              <n.icon /> {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="admin-body">
          <Routes>
            <Route index element={<OverviewAdmin />} />
            <Route path="ai" element={<AiAdmin />} />
            <Route path="integrations" element={<PluginsAdmin />} />
            <Route path="guidance" element={<GuidanceAdmin />} />
            <Route path="users" element={<UsersAdmin />} />
            <Route path="audit" element={<AuditAdmin />} />
            <Route path="*" element={<Navigate to="/admin" replace />} />
          </Routes>
        </div>
      </div>
    </Shell>
  );
}
