import Link from "next/link";
import { notFound } from "next/navigation";
import { Icon } from "@/components/ui/icons";
import { PublicFooter, PublicHeader } from "@/components/ui/public";
import { market } from "@/lib/countries";

// One front door per side of the platform. Each says what you do, what you need, what it costs or commits you to, and goes straight to
// sign-up for that side. Copy that depends on the country (identifiers, regulator, registry) is read from the country pack.

type Door = { role: "seller" | "buyer" | "financier"; name: string; icon: string; head: string; lead: string; steps: [string, string][]; need: string[]; terms: [string, string][]; cta: string };

const unique = (xs: string[]) => [...new Set(xs)];

function door(role: string): Door | null {
  const m = market();
  const ids = unique([m.ids.kyb.label, m.ids.taxReg.label]).join(" and ");
  if (role === "seller") return {
    role, name: "Sellers", icon: "invoice", head: "Get paid on your invoices without waiting for the due date.",
    lead: "You sell on credit terms. Your buyer confirms the invoice, a licensed financier funds it, and you receive the advance in days. You see the full cost before you accept.",
    steps: [
      ["Verify your business", `One check with your ${ids}, your directors and your settlement bank account.`],
      ["Name your buyers", "Tell us who owes you and who confirms their invoices. They do not need an account to confirm."],
      ["Upload an invoice", `Duplicates and invalid ${m.eInvoice.short.toLowerCase()}s are caught straight away.`],
      ["Compare offers and accept", "Read the Key Facts sheet: advance, fee, all-in yearly cost, and what happens if your buyer pays late."],
      ["Sign and get paid", `You e-sign under ${m.terms.esign}; the advance goes to your verified account. The rest comes to you after your buyer pays.`],
    ],
    need: [`Your ${ids}`, m.ids.companyReg ? `Your ${m.ids.companyReg.label}, if you have one` : "Your company registration", "A director or owner's identity number", "A bank account in the company's name", "Invoices with the buyer's name and tax number on them"],
    terms: [
      ["What it costs", "A processing fee up front and a discount for the days the money is out, both shown before you accept."],
      ["If the buyer does not pay", "Depends on the offer: with recourse you repay the advance; without recourse the financier carries the risk. The offer says which."],
      ["Your data", `Handled under ${m.privacy.law}.`],
    ],
    cta: "Create a seller account",
  };
  if (role === "buyer") return {
    role, name: "Buyers", icon: "building", head: "Confirm in one click. Pay on the original due date.",
    lead: "Your suppliers use Marichi to be paid early. Your terms do not change: you pay the date you always would, to the account shown on that invoice.",
    steps: [
      ["Your supplier names you", "They give us the email of the person at your company who confirms invoices."],
      ["You get a link", "Open it, enter the one-time code sent to the same address, and see the invoice. No account is needed."],
      ["Confirm, dispute or ask", "Your answer is recorded with the exact wording you agreed to, and a confirmation record is made."],
      ["Pay on the due date", "Pay only into the collection account in the assignment notice. Payments anywhere else do not settle the invoice."],
    ],
    need: ["An email address that belongs to your company, not to the supplier", `Your ${ids}, only if you create an account afterwards`],
    terms: [
      ["What you agree to", "That the invoice is valid and payable on its due date, without set-off, when you confirm it. The wording is shown on the page before you answer."],
      ["Your own account", "Optional. It lets you see everything you owe, set up automatic payment and, if you wish, run a supplier finance programme."],
      ["Your data", `Handled under ${m.privacy.law}.`],
    ],
    cta: "Create a buyer account",
  };
  if (role === "financier") return {
    role, name: "Financiers", icon: "bank", head: "Lend against invoices the buyer has confirmed.",
    lead: `For licensed institutions. You set the mandate, we show you confirmed invoices, you bid. Your money sits in the escrow account and is only moved against signed agreements${m.registry ? ` and, where the law requires it, a filing at ${m.registry.short}` : ""}.`,
    steps: [
      ["Verify your company", "The same company check every business passes."],
      ["Apply with your licence", `Tell us who regulates you (for example ${m.regulator}), your licence and where it applies. Our team checks it before you can bid or hold funds.`],
      ["Set your mandate and limits", "Ticket size, tenor, grade, industries, a cap per seller and a credit limit for each buyer. Standing bids are optional."],
      ["Fund your account", "Transfer to the escrow account and tell operations the bank reference. Your balance shows here."],
      ["Bid, fund, collect", "Bid on deals that fit. The buyer pays into a collection account; principal and your return come back to your account."],
    ],
    need: ["A licence to lend or factor in this country", `A regulator we can verify (${m.regulator} or the one that applies to you)`, "A settlement account in your institution's name", "Someone who can accept the participation terms for the institution"],
    terms: [
      ["What you earn", "The discount you bid, less the platform's share, which is shown to you on every deal."],
      ["Where the risk sits", "Recourse or not is on each offer. Every bid is checked against your mandate and your limit on that buyer."],
      ["Institutions only", "Individuals cannot fund invoices on the platform."],
    ],
    cta: "Apply as a financier",
  };
  return null;
}

export default async function FrontDoor({ params }: { params: Promise<{ role: string }> }) {
  const d = door((await params).role);
  if (!d) notFound();
  const others = (["seller", "buyer", "financier"] as const).filter((r) => r !== d.role);
  return (
    <div data-role={d.role} className="bg-card">
      <PublicHeader />
      <section className="bg-p-950 text-white">
        <div className="mx-auto grid max-w-6xl gap-10 px-4 py-16 sm:px-6 lg:grid-cols-[3fr_2fr] lg:py-24">
          <div>
            <span className="pill bg-white/10 text-lt-100"><Icon name={d.icon} className="h-3.5 w-3.5" />For {d.name.toLowerCase()} in {market().name}</span>
            <h1 className="mt-5 text-[clamp(30px,4.4vw,48px)] leading-[1.1] font-semibold tracking-tight">{d.head}</h1>
            <p className="mt-5 max-w-xl text-[16.5px] leading-relaxed text-lt-100/80">{d.lead}</p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href={`/signup?as=${d.role}`} className="btn bg-s-500 px-6 text-p-950 hover:brightness-105">{d.cta}<Icon name="arrow-right" className="h-4 w-4" /></Link>
              <Link href="/login" className="btn px-6 text-white ring-1 ring-white/30 hover:bg-white/10">Log in</Link>
            </div>
          </div>
          <div className="rounded-panel bg-white/6 p-6 ring-1 ring-white/10">
            <p className="text-[13px] font-semibold tracking-[.1em] text-lt-200/70 uppercase">Have ready</p>
            <ul className="mt-4 space-y-3">
              {d.need.map((n) => <li key={n} className="flex gap-3 text-[14.5px] text-lt-100"><Icon name="check" className="mt-0.5 h-4 w-4 shrink-0 text-s-500" />{n}</li>)}
            </ul>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
        <p className="text-xs font-semibold tracking-[.14em] text-p-600 uppercase">How it works for you</p>
        <ol className="stagger mt-8 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
          {d.steps.map(([t, b], n) => (
            <li key={t} className="rounded-card bg-panel p-5">
              <span className="grid h-8 w-8 place-items-center rounded-full bg-p-700 text-sm font-bold text-white">{n + 1}</span>
              <h2 className="mt-3 font-semibold">{t}</h2><p className="mt-1 text-[14.5px] text-muted">{b}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="bg-page">
        <div className="mx-auto grid max-w-6xl gap-5 px-4 py-14 sm:px-6 md:grid-cols-3">
          {d.terms.map(([t, b]) => <div key={t} className="rounded-card bg-card p-6 shadow-card"><h2 className="font-semibold">{t}</h2><p className="mt-1.5 text-[14.5px] text-muted">{b}</p></div>)}
        </div>
        <p className="mx-auto max-w-6xl px-4 pb-14 text-sm text-muted sm:px-6">
          Not a {d.role}? <Link className="font-semibold text-p-700 hover:underline" href={`/for/${others[0]}`}>For {others[0]}s</Link> or <Link className="font-semibold text-p-700 hover:underline" href={`/for/${others[1]}`}>for {others[1]}s</Link>.
          {" "}All agreements and clause text are drafts until reviewed by counsel in {market().name}.
        </p>
      </section>
      <PublicFooter />
    </div>
  );
}
