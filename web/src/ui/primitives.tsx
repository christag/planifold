import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { useApp } from "../lib/store.js";
import { X } from "./icons.js";

export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <span className="logo" aria-label="Piecewise">
      <span className="logo-mark" aria-hidden>
        <i className="kind-input" />
        <i className="kind-transform" />
        <i className="kind-output" />
      </span>
      {!compact && <span className="logo-word serif">Piecewise</span>}
    </span>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="row" role="status">
      <span className="spinner" />
      {label && <span className="small muted">{label}</span>}
    </span>
  );
}

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismissToast);
  if (!toasts.length) return null;
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} onClick={() => dismiss(t.id)}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(() => window.matchMedia("(max-width: 860px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 860px)");
    const fn = () => setMobile(mq.matches);
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, []);
  return mobile;
}

interface PopoverProps {
  anchor: HTMLElement | null;
  onClose(): void;
  children: ReactNode;
  label: string;
  /** Preferred width in px on desktop. */
  width?: number;
  /** Render as a bottom sheet even on desktop. */
  sheet?: boolean;
  title?: ReactNode;
}

/**
 * Anchored menu on desktop, bottom sheet on narrow screens. Closes on Escape
 * and outside clicks, and returns focus to the anchor.
 */
export function Popover({ anchor, onClose, children, label, width = 320, sheet, title }: PopoverProps) {
  const mobile = useIsMobile();
  const asSheet = mobile || !!sheet;
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number } | null>(null);

  useLayoutEffect(() => {
    if (asSheet) return;
    const place = () => {
      const el = ref.current;
      if (!el) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const w = Math.min(width, vw - 16);
      const r = anchor?.getBoundingClientRect() ?? { left: vw / 2 - w / 2, right: vw / 2 + w / 2, top: vh / 2, bottom: vh / 2 };
      const h = el.offsetHeight;
      let left = Math.max(8, Math.min(r.left, vw - 8 - w));
      let top = r.bottom + 6;
      let maxHeight = vh - top - 8;
      if (maxHeight < Math.min(h, 260) && r.top - 6 > vh - r.bottom) {
        maxHeight = r.top - 14;
        top = Math.max(8, r.top - 6 - Math.min(h, maxHeight));
      }
      setPos({ top, left, maxHeight: Math.max(160, maxHeight) });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor, asSheet, width]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor?.contains(t)) return;
      onClose();
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDown);
    const restore = anchor;
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDown);
      restore?.focus?.({ preventScroll: true });
    };
  }, [anchor, onClose]);

  useEffect(() => {
    const first = ref.current?.querySelector<HTMLElement>("input, [role='option'], button");
    first?.focus({ preventScroll: true });
  }, []);

  if (asSheet) {
    return createPortal(
      <>
        <div className="sheet-backdrop" onClick={onClose} />
        <div className="sheet" role="dialog" aria-label={label} ref={ref}>
          <div className="sheet-handle" />
          {title && (
            <div className="spread" style={{ padding: "4px 16px 8px" }}>
              <div className="grow">{title}</div>
              <button className="btn ghost icon sm" onClick={onClose} aria-label="Close">
                <X />
              </button>
            </div>
          )}
          {children}
        </div>
      </>,
      document.body,
    );
  }
  return createPortal(
    <div
      className="popover"
      role="dialog"
      aria-label={label}
      ref={ref}
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, width: Math.min(width, window.innerWidth - 16), maxHeight: pos?.maxHeight, visibility: pos ? "visible" : "hidden" }}
    >
      {title && (
        <div className="spread" style={{ padding: "10px 12px 6px" }}>
          <div className="grow">{title}</div>
          <button className="btn ghost icon sm" onClick={onClose} aria-label="Close">
            <X />
          </button>
        </div>
      )}
      {children}
    </div>,
    document.body,
  );
}

/** A confirm step that lives inline instead of a browser dialog. */
export function Confirm({ question, confirmLabel = "Delete", onConfirm, onCancel, danger = true }: { question: string; confirmLabel?: string; onConfirm(): void; onCancel(): void; danger?: boolean }) {
  return (
    <div className="row wrap" role="alertdialog" aria-label={question}>
      <span className="small">{question}</span>
      <button className={`btn sm ${danger ? "danger" : "primary"}`} onClick={onConfirm} autoFocus>
        {confirmLabel}
      </button>
      <button className="btn sm ghost" onClick={onCancel}>
        Keep
      </button>
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children && <p className="small">{children}</p>}
      {action && <div style={{ marginTop: 14 }}>{action}</div>}
    </div>
  );
}

export function BackLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="small muted">
      ← {children}
    </Link>
  );
}
