import { useRef, useState, type ReactNode } from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import { useApp } from "../lib/store.js";
import { ChevronDown, LogOut, Menu, Settings, UserIcon } from "./icons.js";
import { Logo, Popover, useIsMobile } from "./primitives.js";

/** Top bar for every page except the plan workspace, which has its own. */
export function Shell({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  const user = useApp((s) => s.user);
  const authConfig = useApp((s) => s.authConfig);
  const logout = useApp((s) => s.logout);
  const navigate = useNavigate();
  const mobile = useIsMobile();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuBtn = useRef<HTMLButtonElement>(null);
  const isAdmin = user?.role === "app_admin";
  const manages = user?.role === "integration_admin" || isAdmin;

  const links = (
    <>
      <NavLink to="/" end className="nav-link">
        Plans
      </NavLink>
      {manages && (
        <NavLink to="/integrations" className="nav-link">
          Integrations
        </NavLink>
      )}
      {isAdmin && (
        <NavLink to="/admin" className="nav-link">
          Admin
        </NavLink>
      )}
    </>
  );

  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar-inner">
          <Link to="/" className="topbar-logo" aria-label="Piecewise home">
            <Logo />
          </Link>
          {authConfig?.orgName && <span className="topbar-org hide-mobile">{authConfig.orgName}</span>}
          {!mobile && <nav className="topbar-nav">{links}</nav>}
          <div className="grow" />
          {user && (
            <>
              <button ref={menuBtn} className="btn ghost" onClick={() => setMenuOpen(true)} aria-haspopup="menu" aria-expanded={menuOpen}>
                {mobile ? <Menu /> : <UserIcon />}
                <span className="hide-mobile">{user.name}</span>
                {!mobile && <ChevronDown />}
              </button>
              {menuOpen && (
                <Popover anchor={menuBtn.current} onClose={() => setMenuOpen(false)} label="Account menu" width={240}>
                  <div className="menu-list" role="menu" onClick={() => setMenuOpen(false)}>
                    {mobile && (
                      <div className="menu-section">
                        {links}
                      </div>
                    )}
                    <div className="menu-item static">
                      <div className="small" style={{ fontWeight: 500 }}>
                        {user.name}
                      </div>
                      <div className="tiny muted">{user.email}</div>
                    </div>
                    <button className="menu-item" role="menuitem" onClick={() => navigate("/account")}>
                      <Settings /> Account
                    </button>
                    <button
                      className="menu-item"
                      role="menuitem"
                      onClick={async () => {
                        await logout();
                        navigate("/login");
                      }}
                    >
                      <LogOut /> Sign out
                    </button>
                  </div>
                </Popover>
              )}
            </>
          )}
        </div>
      </header>
      <main className={`page ${wide ? "" : ""}`}>{children}</main>
    </div>
  );
}
