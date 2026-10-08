"use client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Icon } from "@/components/ui/icons";
import { completeTour } from "./actions";
import { stepsFor } from "./steps";

const PAD = 6;
const GAP = 14;
type Rect = { top: number; left: number; width: number; height: number };

/** First element with this data-tour id that is actually visible (the sidebar exists twice: desktop rail and mobile drawer). */
function findTarget(id: string): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>(`[data-tour="${id}"]`)) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return el;
  }
  return null;
}
const rectOf = (el: HTMLElement): Rect => { const r = el.getBoundingClientRect(); return { top: r.top, left: r.left, width: r.width, height: r.height }; };

export function Tour({ role, firstName, autoStart, open, onOpen, onClose }: { role: string; firstName: string; autoStart: boolean; open: boolean; onOpen: () => void; onClose: () => void }) {
  const router = useRouter();
  const path = usePathname();
  const steps = useMemo(() => stepsFor(role, firstName), [role, firstName]);
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const [vp, setVp] = useState({ w: 1200, h: 800 });
  const [size, setSize] = useState({ w: 380, h: 260 });
  const card = useRef<HTMLDivElement>(null);
  const dir = useRef(1);
  const started = useRef(false);
  const step = steps[i];
  const isHome = path === "/dashboard" || path === "/admin";

  // First visit: open once, on the home screen, after the page has settled.
  useEffect(() => {
    if (!autoStart || started.current || !isHome) return;
    const t = setTimeout(() => { started.current = true; onOpen(); }, 800);
    return () => clearTimeout(t);
  }, [autoStart, isHome, onOpen]);

  useEffect(() => { if (open) { dir.current = 1; setI(0); setRect(null); } }, [open]);

  const finish = useCallback((to?: string) => {
    window.dispatchEvent(new CustomEvent("shell:nav", { detail: false }));
    completeTour().catch(() => { /* not persisted: it may show again, which is harmless */ });
    onClose();
    if (to) router.push(to);
  }, [onClose, router]);

  const go = useCallback((d: 1 | -1) => {
    dir.current = d;
    setI((x) => { const n = x + d; return n < 0 ? 0 : n; });
  }, []);

  // Resolve the current step: open the mobile drawer if needed, find and frame the target, skip optional steps that are absent.
  useEffect(() => {
    if (!open) return;
    if (i >= steps.length) { finish(); return; }
    const mobile = window.matchMedia("(max-width: 1023px)").matches;
    window.dispatchEvent(new CustomEvent("shell:nav", { detail: Boolean(step.nav && mobile) }));
    const t = setTimeout(() => {
      if (!step.target) { setRect(null); return; }
      const el = findTarget(step.target);
      if (!el) {
        if (step.optional) { if (i === 0 && dir.current < 0) return; go(dir.current as 1 | -1); }
        else setRect(null);
        return;
      }
      el.scrollIntoView({ block: "center", inline: "nearest" });
      requestAnimationFrame(() => setRect(rectOf(el)));
    }, step.nav && mobile ? 360 : 60);
    return () => clearTimeout(t);
  }, [open, i, step, steps.length, finish, go]);

  // Keep the frame glued to the target on resize/scroll.
  useEffect(() => {
    if (!open || !step?.target) return;
    const re = () => { const el = findTarget(step.target!); if (el) setRect(rectOf(el)); setVp({ w: window.innerWidth, h: window.innerHeight }); };
    re();
    window.addEventListener("resize", re); window.addEventListener("scroll", re, true);
    return () => { window.removeEventListener("resize", re); window.removeEventListener("scroll", re, true); };
  }, [open, step]);
  useEffect(() => { if (open) setVp({ w: window.innerWidth, h: window.innerHeight }); }, [open]);

  useLayoutEffect(() => { if (open && card.current) setSize({ w: card.current.offsetWidth, h: card.current.offsetHeight }); }, [open, i, vp.w]);
  useEffect(() => { if (open) card.current?.focus(); }, [open, i]);

  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(); }
      else if (e.key === "ArrowRight") { e.preventDefault(); if (i === steps.length - 1) finish(); else go(1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); go(-1); }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [open, i, steps.length, finish, go]);

  if (!open || !step) return null;

  const last = i === steps.length - 1;
  const small = vp.w < 640;
  const clampX = (x: number) => Math.min(Math.max(12, x), vp.w - size.w - 12);
  const clampY = (y: number) => Math.min(Math.max(12, y), vp.h - size.h - 12);
  let pos: React.CSSProperties;
  if (small) {
    const lower = rect ? rect.top + rect.height / 2 > vp.h / 2 : true;
    pos = { left: 8, right: 8, ...(lower && rect ? { top: 8 } : { bottom: 8 }) };
  } else if (!rect) {
    pos = { top: Math.max(12, (vp.h - size.h) / 2), left: Math.max(12, (vp.w - size.w) / 2) };
  } else {
    const l = rect.left - PAD, t = rect.top - PAD, r = rect.left + rect.width + PAD, b = rect.top + rect.height + PAD;
    const cx = rect.left + rect.width / 2 - size.w / 2;
    if (r + GAP + size.w <= vp.w - 12) pos = { left: r + GAP, top: clampY(t) };
    else if (b + GAP + size.h <= vp.h - 12) pos = { top: b + GAP, left: clampX(cx) };
    else if (t - GAP - size.h >= 12) pos = { top: t - GAP - size.h, left: clampX(cx) };
    else if (l - GAP - size.w >= 12) pos = { left: l - GAP - size.w, top: clampY(t) };
    else pos = { top: clampY((vp.h - size.h) / 2), left: clampX((vp.w - size.w) / 2) };
  }

  return (
    <div className="fixed inset-0 z-[95]" role="presentation">
      {/* Blocks clicks on the page behind. Without a target it also dims the screen. */}
      <div className={`absolute inset-0 ${rect ? "" : "bg-p-950/60 anim-in"}`} />
      {rect && (
        <div aria-hidden className="pointer-events-none absolute rounded-lg transition-all duration-300 ease-out"
          style={{ top: rect.top - PAD, left: rect.left - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2, background: "rgb(255 255 255 / .09)", boxShadow: "0 0 0 9999px rgb(10 30 22 / .62), 0 0 0 2px var(--color-s-500)" }} />
      )}
      <div ref={card} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="tour-title" aria-live="polite" key={step.id}
        className="anim-pop absolute w-[min(380px,calc(100vw-1rem))] overflow-hidden rounded-panel bg-card shadow-pop outline-none transition-[top,left] duration-300 sm:w-[380px]" style={pos}>
        <div className="h-1 bg-panel"><div className="h-full bg-s-500 transition-all duration-300" style={{ width: `${((i + 1) / steps.length) * 100}%` }} /></div>
        <div className="p-5">
          <div className="flex items-center justify-between">
            <span className="text-[11.5px] font-semibold tracking-[.08em] text-faint uppercase">Step {i + 1} of {steps.length}</span>
            <button onClick={() => finish()} aria-label="Close tour" className="-m-1 grid h-7 w-7 place-items-center rounded-md text-faint hover:bg-panel hover:text-ink"><Icon name="close" className="h-4 w-4" /></button>
          </div>
          <h2 id="tour-title" className="mt-2 text-[19px] font-semibold tracking-tight">{step.title}</h2>
          <p className="mt-1.5 text-[14px] leading-relaxed text-muted">{step.body}</p>
          {step.flow && (
            <ol className="mt-3 space-y-2">
              {step.flow.map((f, n) => (
                <li key={f} className="flex items-start gap-3 text-[13.5px]">
                  <span className="mt-px grid h-5 w-5 shrink-0 place-items-center rounded-full bg-p-100 text-[11px] font-bold text-p-700">{n + 1}</span>{f}
                </li>
              ))}
            </ol>
          )}
          <div className="mt-5 flex items-center justify-between gap-2">
            <button onClick={() => finish()} className="text-sm font-medium text-muted underline-offset-2 hover:text-ink hover:underline">Skip tour</button>
            <div className="flex gap-2">
              {i > 0 && <button onClick={() => go(-1)} className="btn btn-ghost btn-sm">Back</button>}
              {last && step.cta && <button onClick={() => finish(step.cta!.href)} className="btn btn-ghost btn-sm">{step.cta.label}</button>}
              <button onClick={() => (last ? finish() : go(1))} className="btn btn-primary btn-sm">{step.nextLabel ?? "Next"}</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
