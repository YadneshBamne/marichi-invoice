import Link from "next/link";
import type { ReactNode } from "react";
import { Icon, Logo } from "./icons";

export function Brand({ light, className = "" }: { light?: boolean; className?: string }) {
  return (
    <Link href="/" className={`flex items-center gap-3 ${className}`} aria-label="Marichi Labs home">
      <Logo className="h-9 w-9" />
      <span className="leading-tight">
        <span className={`block text-[19px] font-semibold tracking-tight ${light ? "text-white" : "text-ink"}`}>Marichi</span>
        <span className={`block text-[10.5px] tracking-[.12em] uppercase ${light ? "text-p-200/60" : "text-faint"}`}>Invoice financing</span>
      </span>
    </Link>
  );
}

export function PublicHeader() {
  const link = "rounded-lg px-3 py-2 text-sm font-medium text-muted transition-colors hover:bg-panel hover:text-ink";
  return (
    <header className="sticky top-0 z-30 border-b border-hair bg-card/90 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-4 sm:px-6">
        <Brand />
        <nav aria-label="Site" className="ml-6 hidden items-center gap-1 md:flex">
          <a className={link} href="/#how">How it works</a>
          <a className={link} href="/#who">Who it&apos;s for</a>
          <a className={link} href="/#trust">Security</a>
          <a className={link} href="/#roadmap">Roadmap</a>
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <Link href="/login" className="btn btn-ghost btn-sm">Log in</Link>
          <Link href="/signup" className="btn btn-primary btn-sm">Get started</Link>
        </div>
      </div>
    </header>
  );
}

export function PublicFooter() {
  const h = "text-[11px] font-semibold tracking-[.1em] text-p-200/60 uppercase";
  const l = "block py-1 text-sm text-p-100/75 transition-colors hover:text-white";
  return (
    <footer className="bg-p-950 text-p-100">
      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-12 sm:px-6 md:grid-cols-4">
        <div className="md:col-span-2">
          <Brand light />
          <p className="mt-4 max-w-sm text-sm text-p-100/70">Working capital against approved invoices for Indian MSMEs, with buyer-confirmed invoices, transparent pricing and a full audit trail.</p>
        </div>
        <div><p className={h}>Product</p><a className={l} href="/#how">How it works</a><a className={l} href="/#trust">Security and control</a><a className={l} href="/#roadmap">Roadmap</a></div>
        <div><p className={h}>Company</p><Link className={l} href="/grievance">Grievance redressal</Link><Link className={l} href="/terms">Terms of use</Link><Link className={l} href="/privacy">Privacy notice</Link></div>
      </div>
      <div className="border-t border-white/10">
        <p className="mx-auto max-w-6xl px-4 py-5 text-xs text-p-200/60 sm:px-6">&copy; {new Date().getFullYear()} Marichi Labs. All rights reserved.</p>
      </div>
    </footer>
  );
}

/** Frame for simple signed-out content pages (grievance, terms, privacy): site header + footer around one card. */
export function PublicFrame({ wide, children }: { wide?: boolean; children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-page">
      <PublicHeader />
      <main className={`anim-up mx-auto w-full flex-1 px-4 py-10 sm:px-6 sm:py-14 ${wide ? "max-w-3xl" : "max-w-md"}`}>
        <div className="rounded-panel bg-card p-6 shadow-card sm:p-9">{children}</div>
      </main>
      <PublicFooter />
    </div>
  );
}

const POINTS = [
  { icon: "shield", t: "Two-factor sign-in on every account", d: "Staff and customers alike." },
  { icon: "receipt", t: "Buyer-confirmed invoices", d: "Nothing is financed until the buyer confirms it." },
  { icon: "scale", t: "Auditable by design", d: "Double-entry ledger, daily reconciliation, full audit log." },
];

/** Split-screen frame for sign-in, sign-up and recovery: brand panel on the left (hidden on small screens), form on the right. */
export function AuthLayout({ title, sub, wide, children, footer }: { title: string; sub?: string; wide?: boolean; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <aside className="relative hidden overflow-hidden bg-p-950 p-12 text-white lg:flex lg:flex-col">
        <div aria-hidden className="pointer-events-none absolute -right-24 -bottom-24 h-96 w-96 rounded-full border-[44px] border-white/5" />
        <div aria-hidden className="pointer-events-none absolute -right-4 -bottom-4 h-56 w-56 rounded-full border-[26px] border-white/5" />
        <Brand light />
        <div className="my-auto max-w-md">
          <h2 className="text-[34px] leading-[1.15] font-semibold tracking-tight">Working capital against the invoices you have already earned.</h2>
          <p className="mt-4 text-[15.5px] leading-relaxed text-p-100/75">One platform for sellers, their buyers and the teams that run the programme.</p>
          <ul className="stagger mt-10 space-y-5">
            {POINTS.map((p) => (
              <li key={p.t} className="flex gap-4">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-white/10"><Icon name={p.icon} className="h-5 w-5 text-p-200" /></span>
                <span><span className="block font-semibold">{p.t}</span><span className="block text-sm text-p-100/65">{p.d}</span></span>
              </li>
            ))}
          </ul>
        </div>
        <p className="text-xs text-p-200/55">&copy; {new Date().getFullYear()} Marichi Labs</p>
      </aside>

      <main className="flex flex-col bg-card">
        <div className="flex items-center justify-between px-5 pt-5 lg:hidden"><Brand /></div>
        <div className="flex flex-1 items-center justify-center px-5 py-10 sm:px-10">
          <div className={`anim-up w-full ${wide ? "max-w-lg" : "max-w-sm"}`}>
            <h1 className="text-[28px] font-semibold tracking-tight">{title}</h1>
            {sub && <p className="mt-2 text-[15px] text-muted">{sub}</p>}
            <div className="mt-8">{children}</div>
            {footer && <div className="mt-8 text-sm text-muted">{footer}</div>}
          </div>
        </div>
        <p className="px-5 pb-6 text-center text-xs text-faint sm:px-10">
          <Link className="underline-offset-2 hover:underline" href="/terms">Terms</Link> &middot; <Link className="underline-offset-2 hover:underline" href="/privacy">Privacy</Link> &middot; <Link className="underline-offset-2 hover:underline" href="/grievance">Grievance redressal</Link>
        </p>
      </main>
    </div>
  );
}
