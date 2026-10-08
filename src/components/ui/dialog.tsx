"use client";
import { useEffect, useRef, type ReactNode } from "react";

/** Minimal accessible modal: Esc and backdrop close it, focus moves in, and returns to the opener on close. */
export function Dialog({ open, onClose, label, className = "max-w-lg", top, children }: { open: boolean; onClose: () => void; label: string; className?: string; top?: boolean; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    box.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey, true); document.body.style.overflow = ""; prev?.focus?.(); };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className={`fixed inset-0 z-[80] flex justify-center bg-p-950/50 p-4 backdrop-blur-[2px] anim-in ${top ? "items-start pt-[12vh]" : "items-center"}`} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={box} tabIndex={-1} role="dialog" aria-modal="true" aria-label={label} className={`anim-pop w-full rounded-panel bg-card shadow-pop outline-none ${className}`}>{children}</div>
    </div>
  );
}
