import type { Catalog } from "@piecewise/shared";
import { create } from "zustand";
import { api, ApiError } from "./api.js";
import type { AuthConfig, HelperStatus, User } from "./types.js";

export type Theme = "system" | "light" | "dark";

interface Toast {
  id: number;
  text: string;
  kind: "info" | "danger";
}

interface AppState {
  booted: boolean;
  user: User | null;
  authConfig: AuthConfig | null;
  catalog: Catalog | null;
  helperStatus: HelperStatus | null;
  theme: Theme;
  toasts: Toast[];
  boot(): Promise<void>;
  setUser(user: User | null): void;
  loadCatalog(): Promise<void>;
  refreshHelperStatus(): Promise<void>;
  logout(): Promise<void>;
  setTheme(t: Theme): void;
  toast(text: string, kind?: Toast["kind"]): void;
  dismissToast(id: number): void;
}

function readTheme(): Theme {
  try {
    const t = localStorage.getItem("piecewise.theme");
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

function applyTheme(t: Theme) {
  const root = document.documentElement;
  if (t === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", t);
}

let toastId = 0;

export const useApp = create<AppState>((set, get) => ({
  booted: false,
  user: null,
  authConfig: null,
  catalog: null,
  helperStatus: null,
  theme: readTheme(),
  toasts: [],

  async boot() {
    applyTheme(get().theme);
    const [authConfig, me] = await Promise.all([
      api.auth.config().catch(() => null),
      api.auth.me().catch(() => null),
    ]);
    set({ authConfig, user: me?.user ?? null, booted: true });
    if (me?.user) void Promise.all([get().loadCatalog(), get().refreshHelperStatus()]);
  },

  setUser(user) {
    set({ user });
    if (user) void Promise.all([get().loadCatalog(), get().refreshHelperStatus()]);
  },

  async loadCatalog() {
    try {
      const { catalog } = await api.catalog();
      set({ catalog });
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) get().toast("Couldn't load the integration catalog.", "danger");
    }
  },

  async refreshHelperStatus() {
    try {
      set({ helperStatus: await api.helperStatus() });
    } catch {
      /* not signed in */
    }
  },

  async logout() {
    await api.auth.logout().catch(() => undefined);
    set({ user: null, catalog: null, helperStatus: null });
  },

  setTheme(theme) {
    try {
      localStorage.setItem("piecewise.theme", theme);
    } catch {
      /* private mode */
    }
    applyTheme(theme);
    set({ theme });
  },

  toast(text, kind = "info") {
    const id = ++toastId;
    set((s) => ({ toasts: [...s.toasts, { id, text, kind }] }));
    setTimeout(() => get().dismissToast(id), kind === "danger" ? 6000 : 3500);
  },

  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.issues?.length ? `${e.message} ${e.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}` : e.message;
  return (e as Error)?.message || "Something went wrong.";
}
