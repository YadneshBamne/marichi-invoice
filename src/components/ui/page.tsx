import Link from "next/link";
import type { ReactNode } from "react";
import { Icon } from "./icons";

/* The page system. Every screen is built from these, so spacing, headers and tables look the same everywhere. */

export function PageHead({ title, sub, back, children }: { title: string; sub?: ReactNode; back?: { href: string; label: string }; children?: ReactNode }) {
  return (
    <div className="mb-6">
      {back && <Link href={back.href} className="mb-2 inline-flex items-center gap-1 text-[13px] font-medium text-muted transition-colors hover:text-ink"><Icon name="chevron-left" className="h-3.5 w-3.5" />{back.label}</Link>}
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0"><h1 className="page-title">{title}</h1>{sub && <p className="page-sub max-w-2xl">{sub}</p>}</div>
        {children && <div className="flex flex-wrap items-center gap-2.5">{children}</div>}
      </div>
    </div>
  );
}

/** A framed section. With a title it gets a header row and a divider; `flush` removes body padding (tables, lists). */
export function Panel({ title, sub, action, flush, className = "", tour, children }: { title?: ReactNode; sub?: ReactNode; action?: ReactNode; flush?: boolean; className?: string; tour?: string; children: ReactNode }) {
  return (
    <section data-tour={tour} className={`overflow-hidden rounded-card bg-card shadow-card ${className}`}>
      {(title || action) && (
        <header className="flex items-center justify-between gap-4 border-b border-hair px-5 py-3.5 sm:px-6">
          <div className="min-w-0"><h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>{sub && <p className="mt-0.5 text-[13px] text-muted">{sub}</p>}</div>
          {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
        </header>
      )}
      <div className={flush ? "" : "p-5 sm:p-6"}>{children}</div>
    </section>
  );
}

export type Col<T> = { h: ReactNode; cell: (row: T, i: number) => ReactNode; align?: "right" | "center"; className?: string };

/** Data grid. Numbers right-aligned, header row tinted, rows highlight on hover, scrolls sideways on small screens. */
export function DataTable<T>({ cols, rows, rowKey, empty }: { cols: Col<T>[]; rows: T[]; rowKey: (r: T) => string; empty?: ReactNode }) {
  if (rows.length === 0) return <div className="px-6 py-10 text-center text-sm text-muted">{empty ?? "Nothing to show."}</div>;
  const al = (a?: string) => (a === "right" ? "text-right" : a === "center" ? "text-center" : "text-left");
  return (
    <div className="overflow-x-auto">
      <table className="dt">
        <thead><tr>{cols.map((c, n) => <th key={n} className={`${al(c.align)} ${c.className ?? ""}`}>{c.h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={rowKey(r)}>{cols.map((c, n) => <td key={n} className={`${al(c.align)} ${c.className ?? ""}`}>{c.cell(r, i)}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

/** Segmented link tabs, e.g. Open / Closed. */
export function Tabs({ items }: { items: { href: string; label: string; active: boolean; count?: number }[] }) {
  return (
    <nav className="inline-flex gap-1 rounded-full bg-panel p-1 ring-1 ring-hair">
      {items.map((t) => (
        <Link key={t.href} href={t.href} aria-current={t.active ? "page" : undefined}
          className={`rounded-full px-4 py-1.5 text-[13px] font-semibold transition-all ${t.active ? "bg-card text-ink shadow-card" : "text-muted hover:text-ink"}`}>
          {t.label}{t.count !== undefined && <span className="ml-1.5 text-faint">{t.count}</span>}
        </Link>
      ))}
    </nav>
  );
}

/**
 * A button that opens a small form in the browser's top layer. Unlike an absolutely placed dropdown it is never clipped by a
 * scrolling table, and a click outside or Escape closes it. `id` must be unique on the page (use the row's id).
 */
export function Pop({ id, label, cls = "btn btn-primary btn-sm", children }: { id: string; label: ReactNode; cls?: string; children: ReactNode }) {
  return (
    <>
      <button type="button" popoverTarget={id} className={cls}>{label}</button>
      <div id={id} popover="auto" className="pop">{children}</div>
    </>
  );
}

/** A labelled field for popover forms. Placeholders disappear as soon as you type, so they are never the only label. */
export function PopField({ label, children }: { label: ReactNode; children: ReactNode }) {
  return <label className="block text-xs font-medium">{label}{children}</label>;
}

/** Label / value pairs. */
export function KV({ rows, cols = 1 }: { rows: [ReactNode, ReactNode][]; cols?: 1 | 2 }) {
  return (
    <dl className={`grid gap-x-10 text-sm ${cols === 2 ? "sm:grid-cols-2" : ""}`}>
      {rows.map(([k, v], i) => <div key={i} className="grid grid-cols-[minmax(7rem,2fr)_3fr] gap-4 border-b border-hair py-2.5 last:border-0"><dt className="text-muted">{k}</dt><dd className="min-w-0 font-medium">{v}</dd></div>)}
    </dl>
  );
}

/** A queue item: header with title and meta, body, and an action footer. Used for reviews and approvals. */
export function ReviewCard({ title, meta, aside, children, actions }: { title: ReactNode; meta?: ReactNode; aside?: ReactNode; children?: ReactNode; actions?: ReactNode }) {
  return (
    <article className="overflow-hidden rounded-card bg-card shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-4 px-5 pt-5 sm:px-6">
        <div className="min-w-0"><h3 className="text-[15.5px] font-semibold tracking-tight">{title}</h3>{meta && <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[13px] text-muted">{meta}</div>}</div>
        {aside && <div className="text-right">{aside}</div>}
      </div>
      {children && <div className="px-5 pt-4 pb-5 text-sm sm:px-6">{children}</div>}
      {actions && <footer className="border-t border-hair bg-panel/60 px-5 py-3 sm:px-6">{actions}</footer>}
      {!children && !actions && <div className="pb-5" />}
    </article>
  );
}

export function Field({ label, hint, className = "", children }: { label: ReactNode; hint?: ReactNode; className?: string; children: ReactNode }) {
  return <label className={`block text-sm font-medium ${className}`}>{label}<span className="mt-1 block font-normal">{children}</span>{hint && <span className="mt-1 block text-xs font-normal text-muted">{hint}</span>}</label>;
}

const TONES = { info: "bg-i-100 text-i-500", good: "bg-g-100 text-g-600", warn: "bg-s-100 text-s-600", bad: "bg-r-100 text-r-600" } as const;
export function Notice({ tone = "info", children }: { tone?: keyof typeof TONES; children: ReactNode }) {
  return <p className={`rounded-lg px-4 py-3 text-sm ${TONES[tone]}`}>{children}</p>;
}

export function EmptyState({ icon = "check", title, children }: { icon?: string; title: string; children?: ReactNode }) {
  return (
    <div className="grid place-items-center rounded-card bg-card px-6 py-14 text-center shadow-card">
      <span className="grid h-12 w-12 place-items-center rounded-full bg-p-100 text-p-700"><Icon name={icon} className="h-6 w-6" /></span>
      <p className="mt-4 font-semibold">{title}</p>
      {children && <p className="mt-1 max-w-sm text-sm text-muted">{children}</p>}
    </div>
  );
}

/** Colour for the many status words used across the product. */
const STATUS_TONE: Record<string, string> = {
  paid: "good", succeeded: "good", approved: "good", eligible: "good", confirmed: "good", resolved: "good", closed: "good", cleared: "good", signed: "good", tied: "good", delivered: "good", sent: "good",
  financed: "info", processing: "info", open: "info", in_progress: "info", assigned: "info", queued: "info", under_review: "warn", submitted: "warn", pending: "warn", due: "warn", awaiting_customer: "warn", clarification: "warn", info_requested: "warn",
  overdue: "bad", failed: "bad", rejected: "bad", disputed: "bad", written_off: "bad", declined: "bad", confirmed_fraud: "bad", breached: "bad",
};
export function StatusPill({ status, label }: { status: string; label?: string }) {
  const t = STATUS_TONE[status] ?? "neutral";
  const cls = t === "neutral" ? "bg-panel text-muted" : TONES[t as keyof typeof TONES];
  return <span className={`pill ${cls}`}>{label ?? status.replaceAll("_", " ")}</span>;
}
