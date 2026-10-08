import { z } from "zod";
import { db } from "@/server/db/client";
import { requireUser } from "@/server/rbac";
import { CROSS, exposure, foreignBuyers, recordForeignPayment } from "@/server/crossborder/service";
import { gateway } from "@/server/integrations/gateway";
import { DataTable, Field, Notice, PageHead, Panel, StatusPill } from "@/components/ui/page";
import { formatINR, formatMinor, rupeesToPaise } from "@/lib/money";
import { attempt } from "../../financier/attempt";

export const metadata = { title: "Cross-border" };
const PATH = "/admin/cross-border";
const input = "field font-normal";

async function receive(fd: FormData) {
  "use server";
  await requireUser(["ops", "admin"]);
  await attempt(PATH, async () => {
    const f = z.object({ accountNumber: z.string().min(6), currency: z.string().length(3), amount: z.string(), utr: z.string().min(4) }).parse(Object.fromEntries(fd));
    const r = await recordForeignPayment(db, { accountNumber: f.accountNumber.trim(), currency: f.currency, foreignAmount: rupeesToPaise(f.amount), utr: f.utr.trim(), receivedAt: new Date() });
    return r.status === "replayed" ? "That payment was already recorded." : `Converted to ${formatINR(r.inr)} at ₹${(Number(r.rateMicro) / 1_000_000).toFixed(4)} and applied to the invoice.`;
  });
}

export default async function CrossBorder({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  await requireUser(["ops", "admin"]);
  const q = await searchParams;
  const [exp, buyers] = await Promise.all([exposure(db), foreignBuyers(db)]);
  const total = exp.reduce((a, e) => a + e.principal, 0n);
  return (
    <>
      <PageHead title="Cross-border" sub="Overseas buyers, open exposure by currency and country, and foreign-currency receipts." />
      {q.ok && <div className="mb-4"><Notice tone="good">{q.ok}</Notice></div>}
      {q.error && <div className="mb-4"><Notice tone="bad">{q.error}</Notice></div>}
      <div className="mb-5 grid gap-5 xl:grid-cols-[1fr_22rem]">
        <Panel title="Open exposure" sub={`${formatINR(total)} advanced against export invoices`} flush>
          <DataTable rows={exp} rowKey={(e) => `${e.currency}${e.country}`} empty="No export invoices outstanding."
            cols={[
              { h: "Currency", cell: (e) => e.currency },
              { h: "Buyer country", cell: (e) => e.country },
              { h: "Invoices", align: "right", cell: (e) => e.invoices },
              { h: "Invoiced", align: "right", cell: (e) => formatMinor(e.foreign, e.currency) },
              { h: "Advanced (₹)", align: "right", cell: (e) => formatINR(e.principal) },
              { h: "Share", align: "right", cell: (e) => `${total > 0n ? Number((e.principal * 100n) / total) : 0}%` },
            ]} />
        </Panel>
        <Panel title="Record a foreign-currency credit" sub="From the bank's credit advice for the invoice's collection account.">
          <form action={receive} className="space-y-3">
            <Field label="Collection account number"><input name="accountNumber" required className={input} /></Field>
            <div className="grid grid-cols-[6rem_1fr] gap-3">
              <Field label="Currency"><select name="currency" className={input}>{CROSS.currencies.map((c) => <option key={c}>{c}</option>)}</select></Field>
              <Field label="Amount received"><input name="amount" inputMode="decimal" required className={input} /></Field>
            </div>
            <Field label="Bank reference"><input name="utr" required className={input} /></Field>
            <button className="btn btn-primary w-full">Convert and apply</button>
            <p className="text-xs text-muted">Converted at the day&apos;s rate less {CROSS.settleSpreadBps / 100}% for the bank&apos;s spread. A shortfall stays with the seller; a surplus is paid back to them.</p>
          </form>
        </Panel>
      </div>
      <Panel title="Overseas buyers" flush>
        <DataTable rows={buyers} rowKey={(b) => b.id} empty="No overseas buyers yet."
          cols={[
            { h: "Company", cell: (b) => b.name },
            { h: "Country", cell: (b) => b.country },
            { h: "Registration", cell: (b) => <span className="font-mono text-[13px] font-normal text-muted">{b.taxId}</span> },
            { h: "Verification", cell: (b) => <StatusPill status={b.status} /> },
          ]} />
      </Panel>
    </>
  );
}
