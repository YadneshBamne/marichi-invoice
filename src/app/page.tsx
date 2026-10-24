import Link from "next/link";
import { Icon } from "@/components/ui/icons";
import { PublicFooter, PublicHeader } from "@/components/ui/public";
import { ROADMAP } from "@/lib/roadmap";

const STEPS = [
  { icon: "layers", t: "Set up your workspace", d: "Choose the apps your company needs, add your logo, and invite your team by email." },
  { icon: "building", t: "Verify your business", d: "A one-time KYB check with PAN, GSTIN, directors and your settlement bank account." },
  { icon: "users", t: "Link your buyers", d: "Invite the companies that owe you money. They verify once and confirm your invoices." },
  { icon: "upload", t: "Upload an invoice", d: "Duplicates and invalid e-invoice numbers are caught immediately. The buyer is asked to confirm." },
  { icon: "scale", t: "Review, sign and get paid", d: "See the advance, fee and all-in annual cost before you accept, then e-sign and receive the advance." },
  { icon: "bank", t: "Buyer settles on the due date", d: "Your buyer pays into a dedicated account. Anything beyond what you owe comes back to you." },
];
const TRUST = [
  { icon: "shield", t: "Two-factor sign-in, everywhere", d: "Every account, customer or staff, uses an authenticator app." },
  { icon: "receipt", t: "Buyer-confirmed invoices", d: "No invoice is financed until the buyer confirms it. Duplicates are blocked." },
  { icon: "scale", t: "Double-entry ledger", d: "Every rupee is booked twice, and the books are reconciled with the bank every day." },
  { icon: "users", t: "Maker-checker on large payouts", d: "A second person must approve payouts above the threshold." },
  { icon: "clock", t: "Full audit trail", d: "Every sensitive change records who did it, when, and what it was before." },
  { icon: "flag", t: "Grievance redressal", d: "Tracked tickets with response times, escalation levels and the Ombudsman route." },
];

export default function Home() {
  const sandbox = (process.env.INTEGRATIONS_MODE ?? "mock") === "mock";
  return (
    <div className="bg-card">
      {sandbox && <p className="bg-s-100 px-4 py-2 text-center text-[13px] font-medium text-s-600">Sandbox environment: banks, KYC and e-sign are simulated. No real money moves.</p>}
      <PublicHeader />

      <section className="relative overflow-hidden bg-p-950 text-white">
        <div aria-hidden className="pointer-events-none absolute -top-32 -right-32 h-[34rem] w-[34rem] rounded-full border-[56px] border-white/[.04]" />
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 py-16 sm:px-6 lg:grid-cols-[1.1fr_.9fr] lg:py-24">
          <div className="anim-up">
            <span className="pill bg-white/10 text-p-100">Invoice financing for MSMEs</span>
            <h1 className="mt-5 text-[clamp(34px,5vw,56px)] leading-[1.06] font-semibold tracking-tight">Get paid on your invoices without waiting for the due date.</h1>
            <p className="mt-5 max-w-xl text-[17px] leading-relaxed text-p-100/80">Marichi turns approved invoices into working capital. Buyers confirm every invoice, pricing is shown in full before you accept, and every step is recorded.</p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="/signup" className="btn rounded-lg bg-s-500 px-6 text-p-950 hover:bg-[#f0a845]">Create an account<Icon name="arrow-right" className="h-4 w-4" /></Link>
              <Link href="/login" className="btn rounded-lg px-6 text-white ring-1 ring-white/30 hover:bg-white/10">Log in</Link>
            </div>
          </div>

          <div className="anim-up [animation-delay:.12s]" aria-label="Example offer">
            <div className="rounded-panel bg-card p-6 text-ink shadow-pop">
              <div className="flex items-center justify-between"><p className="text-[13px] font-semibold text-muted">Your offer</p><span className="pill bg-g-100 text-g-600">Valid for 24 h</span></div>
              <p className="mt-4 text-sm text-muted">Invoice INV-2041 · Big Corp Ltd</p>
              <p className="mt-1 text-[34px] font-semibold tracking-tight">₹4,22,500</p>
              <p className="text-sm text-muted">paid to your bank account today</p>
              <dl className="mt-5 space-y-2.5 border-t border-hair pt-4 text-sm">
                {[["Invoice value", "₹5,00,000"], ["Advance (85%)", "₹4,25,000"], ["Processing fee incl. GST", "− ₹2,500"], ["Discount for 31 days", "charged at repayment"], ["Effective annual cost", "shown before you accept"]].map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-4"><dt className="text-muted">{k}</dt><dd className="font-medium">{v}</dd></div>
                ))}
              </dl>
              <div className="mt-5 rounded-lg bg-p-100 px-4 py-2.5 text-center text-sm font-semibold text-p-700">Accept and sign</div>
            </div>
            <p className="mt-3 text-center text-xs text-p-200/60">Illustrative example, not a live offer.</p>
          </div>
        </div>
      </section>

      <section id="how" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-20 sm:px-6">
        <p className="text-xs font-semibold tracking-[.14em] text-p-600 uppercase">How it works</p>
        <h2 className="mt-2 max-w-2xl text-[clamp(26px,3.4vw,38px)] leading-tight font-semibold tracking-tight">From sign-up to cash in six steps</h2>
        <ol className="stagger mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {STEPS.map((s, n) => (
            <li key={s.t} className="lift rounded-card bg-page p-6">
              <div className="flex items-center justify-between"><span className="grid h-10 w-10 place-items-center rounded-lg bg-p-700 text-white"><Icon name={s.icon} className="h-5 w-5" /></span><span className="text-sm font-bold text-faint">0{n + 1}</span></div>
              <h3 className="mt-4 text-[17px] font-semibold">{s.t}</h3><p className="mt-1.5 text-[14.5px] text-muted">{s.d}</p>
            </li>
          ))}
        </ol>
      </section>

      <section id="who" className="scroll-mt-20 bg-page">
        <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
          <p className="text-xs font-semibold tracking-[.14em] text-p-600 uppercase">Who it&apos;s for</p>
          <h2 className="mt-2 text-[clamp(26px,3.4vw,38px)] font-semibold tracking-tight">One platform, a workspace for each side</h2>
          <div className="mt-10 grid gap-4 lg:grid-cols-3">
            {[
              { role: "seller", t: "Sellers", d: "Suppliers who invoice on credit terms. Upload invoices, see offers, sign and get paid. Track every invoice and your available credit.", icon: "invoice" },
              { role: "buyer", t: "Buyers", d: "Companies whose suppliers use Marichi. Confirm or dispute invoices, see what is due, and pay on the original due date.", icon: "building" },
              { role: "staff", t: "Operations teams", d: "Queues for KYB, underwriting, payouts, collections, fraud and support, with approvals, SLAs and a ledger that reconciles.", icon: "shield" },
            ].map((c) => (
              <div key={c.t} data-role={c.role} className="rounded-card bg-card p-6 shadow-card">
                <span className="grid h-11 w-11 place-items-center rounded-lg bg-p-700 text-white"><Icon name={c.icon} className="h-5 w-5" /></span>
                <h3 className="mt-4 text-lg font-semibold">{c.t}</h3><p className="mt-1.5 text-[14.5px] text-muted">{c.d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="trust" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-20 sm:px-6">
        <p className="text-xs font-semibold tracking-[.14em] text-p-600 uppercase">Security and control</p>
        <h2 className="mt-2 max-w-2xl text-[clamp(26px,3.4vw,38px)] leading-tight font-semibold tracking-tight">Built so every rupee can be explained</h2>
        <ul className="stagger mt-10 grid gap-x-8 gap-y-7 sm:grid-cols-2 lg:grid-cols-3">
          {TRUST.map((t) => (
            <li key={t.t} className="flex gap-4"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-p-100 text-p-700"><Icon name={t.icon} className="h-5 w-5" /></span><span><span className="block font-semibold">{t.t}</span><span className="mt-0.5 block text-[14.5px] text-muted">{t.d}</span></span></li>
          ))}
        </ul>
      </section>

      <section id="roadmap" className="scroll-mt-20 bg-p-950 text-white">
        <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
          <p className="text-xs font-semibold tracking-[.14em] text-s-500 uppercase">Roadmap</p>
          <h2 className="mt-2 max-w-2xl text-[clamp(26px,3.4vw,38px)] leading-tight font-semibold tracking-tight">What we are building next</h2>
          <p className="mt-3 max-w-2xl text-p-100/75">Planned, not yet available. We show it so you know where the platform is going.</p>
          <ul className="stagger mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {ROADMAP.slice(0, 6).map((p) => (
              <li key={p.slug} className="rounded-card bg-white/6 p-5 ring-1 ring-white/10">
                <div className="flex items-center justify-between"><Icon name={p.icon} className="h-5 w-5 text-p-200" /><span className="pill bg-white/10 text-p-100">Phase {p.phase}</span></div>
                <h3 className="mt-3 font-semibold">{p.title}</h3><p className="mt-1 text-sm text-p-100/70">{p.summary}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-20 text-center sm:px-6">
        <h2 className="mx-auto max-w-2xl text-[clamp(26px,3.4vw,38px)] leading-tight font-semibold tracking-tight">Ready to see it with your own invoices?</h2>
        <p className="mx-auto mt-3 max-w-xl text-muted">Create an account, verify your business and your first offer is a few steps away.</p>
        <div className="mt-7 flex justify-center gap-3"><Link href="/signup" className="btn btn-primary px-6">Create an account</Link><Link href="/grievance" className="btn btn-ghost px-6">Talk to us</Link></div>
      </section>
      <PublicFooter />
    </div>
  );
}
