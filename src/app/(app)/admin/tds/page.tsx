import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/server/db/client";
import { requireUser } from "@/server/rbac";
import { recentTds, recordTdsRemittance, taxPayable, tdsReport } from "@/server/tax/tds";
import { rupeesToPaise, formatMoney } from "@/lib/money";
import { market } from "@/lib/countries";
import { DataTable, Notice, PageHead, Panel } from "@/components/ui/page";

export const metadata = { title: "Tax held back" };

async function remit(fd: FormData) {
  "use server";
  const u = await requireUser(["ops", "admin"]);
  try {
    await recordTdsRemittance(db, u, { amount: rupeesToPaise(String(fd.get("amount") ?? "")), ref: String(fd.get("ref") ?? ""), note: String(fd.get("note") ?? "") || undefined });
  } catch (e) { redirect(`/admin/tds?error=${encodeURIComponent(e instanceof Error ? e.message : "Could not record it.")}`); }
  revalidatePath("/admin/tds");
  redirect("/admin/tds?saved=1");
}

const quarter = (d: Date) => { const q = Math.floor(d.getUTCMonth() / 3); return { label: `${d.getUTCFullYear()} Q${q + 1}`, from: new Date(Date.UTC(d.getUTCFullYear(), q * 3, 1)), to: new Date(Date.UTC(d.getUTCFullYear(), q * 3 + 3, 1)) }; };

export default async function Tds({ searchParams }: { searchParams: Promise<{ saved?: string; error?: string }> }) {
  await requireUser(["ops", "compliance", "admin"]);
  const q = await searchParams;
  const now = new Date();
  const cur = quarter(now);
  const prev = quarter(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 1)));
  const [owed, thisQ, lastQ, recent] = await Promise.all([taxPayable(db), tdsReport(db, cur.from, cur.to), tdsReport(db, prev.from, prev.to), recentTds(db, 25)]);
  const name = market().tds.name;
  const cols = [
    { h: "Financier", cell: (r: (typeof thisQ)[number]) => r.name },
    { h: "Earnings it was worked out on", align: "right" as const, cell: (r: (typeof thisQ)[number]) => formatMoney(r.base) },
    { h: "Held back", align: "right" as const, cell: (r: (typeof thisQ)[number]) => formatMoney(r.amount) },
    { h: "Repayments", align: "right" as const, cell: (r: (typeof thisQ)[number]) => r.n },
  ];
  return (
    <>
      <PageHead title="Tax held back" sub={`${name} held from financiers' earnings, what is still owed to the tax authority, and the figures each financier's tax certificate needs. Rates and who must be charged are tax advice: confirm them with the tax adviser before relying on this.`} />
      {q.saved && <div className="mb-4"><Notice tone="good">Recorded.</Notice></div>}
      {q.error && <div className="mb-4"><Notice tone="bad">{q.error}</Notice></div>}
      <div className="mb-5 grid gap-5 xl:grid-cols-[1fr_2fr]">
        <Panel title="Owed to the tax authority" sub="Held back and not yet paid over.">
          <p className="text-[34px] font-semibold tracking-tight">{formatMoney(owed)}</p>
          <form action={remit} className="mt-4 space-y-2">
            <label className="block text-xs font-medium">Amount paid over ({market().currency.code})<input name="amount" inputMode="decimal" required className="field !py-2 text-sm font-normal" /></label>
            <label className="block text-xs font-medium">Payment reference<input name="ref" required className="field !py-2 text-sm font-normal" /></label>
            <label className="block text-xs font-medium">Note (optional)<input name="note" className="field !py-2 text-sm font-normal" /></label>
            <button className="btn btn-primary btn-sm w-full">Record payment to the authority</button>
          </form>
        </Panel>
        <div className="space-y-5">
          <Panel title={`This quarter (${cur.label})`} flush><DataTable rows={thisQ} rowKey={(r) => r.financierId} cols={cols} empty="Nothing held back yet this quarter." /></Panel>
          <Panel title={`Last quarter (${prev.label})`} flush><DataTable rows={lastQ} rowKey={(r) => r.financierId} cols={cols} empty="Nothing held back last quarter." /></Panel>
        </div>
      </div>
      <Panel title="Latest deductions" flush>
        <DataTable rows={recent} rowKey={(r) => r.t.id} empty="No deductions yet."
          cols={[
            { h: "When", cell: (r) => <span className="font-normal text-muted">{r.t.createdAt.toISOString().slice(0, 10)}</span> },
            { h: "Financier", cell: (r) => r.name },
            { h: "Worked out on", align: "right", cell: (r) => formatMoney(r.t.base) },
            { h: "Rate", align: "right", cell: (r) => `${r.t.rateBps / 100}%` },
            { h: "Held back", align: "right", cell: (r) => formatMoney(r.t.amount) },
          ]} />
      </Panel>
    </>
  );
}
