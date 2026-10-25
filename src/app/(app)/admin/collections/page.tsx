import { revalidatePath } from "next/cache";
import { eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/server/db/client";
import { invoices, unmatchedCredits, invoiceCollections } from "@/server/db/schema";
import { requireUser } from "@/server/rbac";
import { delinquencyReport, matchUnmatched, writeOff } from "@/server/collections/service";
import { handOver, issueLegalNotice, listNotices, noticeNo } from "@/server/collections/legal";
import { COLLECTIONS, isoDay } from "@/server/collections/waterfall";
import { recentDebits } from "@/server/collections/nach";
import { DataTable, Notice, PageHead, Panel, Pop, PopField, StatusPill } from "@/components/ui/page";
import { attempt } from "../../financier/attempt";
import { formatMoney } from "@/lib/money";

export const metadata = { title: "Collections" };

async function match(fd: FormData) {
  "use server";
  const u = await requireUser(["ops", "admin"]);
  await matchUnmatched(db, z.uuid().parse(fd.get("creditId")), z.uuid().parse(fd.get("invoiceId")), u);
  revalidatePath("/admin/collections");
}
async function writeOffAction(fd: FormData) {
  "use server";
  const u = await requireUser(["admin"]);
  await writeOff(db, z.uuid().parse(fd.get("invoiceId")), u, String(fd.get("note") ?? ""));
  revalidatePath("/admin/collections");
}

const LEGAL = ["admin", "compliance"];
async function issueNotice(fd: FormData) {
  "use server";
  const u = await requireUser(["admin", "compliance"]);
  await attempt("/admin/collections", async () => {
    const n = await issueLegalNotice(db, u, { invoiceId: z.uuid().parse(fd.get("invoiceId")), addressee: String(fd.get("addressee") ?? "") });
    return `Notice ${noticeNo(n.seq)} issued. The ${n.addressee} has been told and has until ${n.cureBy} to pay.`;
  });
}
async function handoff(fd: FormData) {
  "use server";
  const u = await requireUser(["admin", "compliance"]);
  await attempt("/admin/collections", async () => {
    await handOver(db, u, z.uuid().parse(fd.get("noticeId")), { agency: String(fd.get("agency") ?? ""), note: String(fd.get("note") ?? "") });
    return "Handed over for recovery. The company has been told.";
  });
}

export default async function Collections({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const u = await requireUser(["ops", "admin", "compliance"]);
  const q = await searchParams;
  const today = isoDay(new Date());
  const notices = await listNotices(db);
  const live = new Map<string, typeof notices>();
  for (const x of notices) if (x.n.status === "issued" || x.n.status === "handed_over") live.set(x.n.invoiceId, [...(live.get(x.n.invoiceId) ?? []), x]);
  const [debits, report, unmatched, open] = await Promise.all([
    recentDebits(db, 20),
    delinquencyReport(db),
    db.select().from(unmatchedCredits).where(isNull(unmatchedCredits.resolvedAt)),
    db.select({ id: invoices.id, no: invoices.invoiceNumber }).from(invoiceCollections)
      .innerJoin(invoices, eq(invoices.id, invoiceCollections.invoiceId)).where(isNull(invoiceCollections.closedAt)),
  ]);

  return (
    <>
      <PageHead title="Collections" sub="Open financed invoices by days past due, and bank credits that could not be matched automatically." />
      {q.ok && <div className="mb-4"><Notice tone="good">{q.ok}</Notice></div>}
      {q.error && <div className="mb-4"><Notice tone="bad">{q.error}</Notice></div>}
      <div className="space-y-5">
        <Panel title="Open invoices" sub="Ageing by days past due (DPD)" flush>
          <DataTable rows={report} rowKey={(r) => r.invoiceId} empty="No open financed invoices."
            cols={[
              { h: "Invoice", cell: (r) => r.invoiceNumber },
              { h: "Due", cell: (r) => r.dueDate },
              { h: "DPD", align: "right", cell: (r) => r.dpd },
              { h: "Bucket", cell: (r) => r.bucket === "90+" ? <StatusPill status="written_off" label="90+ NPA" /> : r.bucket === "0" ? <StatusPill status="paid" label="Current" /> : <StatusPill status="due" label={`${r.bucket} days`} /> },
              { h: "Principal", align: "right", cell: (r) => formatMoney(r.principal) },
              { h: "Discount", align: "right", cell: (r) => formatMoney(r.discount) },
              { h: "Penal", align: "right", cell: (r) => formatMoney(r.penal) },
              { h: "Legal", cell: (r) => {
                const mine = live.get(r.invoiceId) ?? [];
                if (mine.length) return <span className="text-xs font-normal text-muted">{mine.map((x) => `${noticeNo(x.n.seq)} to ${x.n.addressee}${x.n.status === "handed_over" ? `, with ${x.n.agency}` : `, pay by ${x.n.cureBy}`}`).join("; ")}</span>;
                if (r.dpd < COLLECTIONS.legalNoticeAfterDpd || !LEGAL.includes(u.role)) return r.dpd >= COLLECTIONS.legalNoticeAfterDpd ? <span className="text-xs font-normal text-s-600">Notice due</span> : null;
                return (
                  <Pop id={`ln-${r.invoiceId}`} label="Legal notice" cls="btn btn-ghost btn-sm">
                    <form action={issueNotice} className="space-y-2">
                      <input type="hidden" name="invoiceId" value={r.invoiceId} />
                      <p className="text-xs text-muted">A written demand with {COLLECTIONS.legalNoticeCureDays} days to pay. It is sent now by email and kept as a PDF.</p>
                      <PopField label="Send to">
                        <select name="addressee" className="field !py-2 text-sm font-normal"><option value="buyer">The buyer (who owes the invoice)</option><option value="seller">The seller (repay under recourse)</option></select>
                      </PopField>
                      <button className="btn btn-primary btn-sm w-full">Issue notice</button>
                    </form>
                  </Pop>
                );
              } },
              { h: "", align: "right", cell: (r) => u.role === "admin" && r.bucket === "90+" && (
                <form action={writeOffAction} className="inline-flex gap-1.5">
                  <input type="hidden" name="invoiceId" value={r.invoiceId} />
                  <input name="note" placeholder="Reason" required className="field-inline w-28 !py-1 text-sm" />
                  <button className="btn btn-ghost btn-sm text-r-600">Write off</button>
                </form>
              ) },
            ]} />
        </Panel>

        {notices.length > 0 && (
          <Panel title="Legal notices and recovery" sub="Formal demands issued, and where recovery was handed over." flush>
            <DataTable rows={notices} rowKey={(x) => x.n.id}
              cols={[
                { h: "Notice", cell: (x) => <a className="font-semibold text-p-700 underline" href={`/api/documents/${x.n.documentRef}`} target="_blank">{noticeNo(x.n.seq)}</a> },
                { h: "Invoice", cell: (x) => x.invoiceNumber },
                { h: "To", cell: (x) => <>{x.to}<span className="block text-xs font-normal text-muted">{x.n.addressee}</span></> },
                { h: "Owed then", align: "right", cell: (x) => formatMoney(x.n.amountDue) },
                { h: "Pay by", cell: (x) => <span className="font-normal text-muted">{x.n.cureBy}</span> },
                { h: "Status", cell: (x) => x.n.status === "handed_over" ? <span>With {x.n.agency}</span> : x.n.status === "issued" ? <StatusPill status="due" label="Issued" /> : <StatusPill status={x.n.status === "cured" ? "paid" : "rejected"} label={x.n.status === "cured" ? "Paid" : "Closed"} /> },
                { h: "", align: "right", cell: (x) => x.n.status === "issued" && LEGAL.includes(u.role) && today > x.n.cureBy && (
                  <Pop id={`ho-${x.n.id}`} label="Hand over" cls="btn btn-primary btn-sm">
                    <form action={handoff} className="space-y-2">
                      <input type="hidden" name="noticeId" value={x.n.id} />
                      <PopField label="Agency or lawyer"><input name="agency" required className="field !py-2 text-sm font-normal" /></PopField>
                      <PopField label="Note (optional)"><input name="note" className="field !py-2 text-sm font-normal" /></PopField>
                      <button className="btn btn-primary btn-sm w-full">Hand over for recovery</button>
                    </form>
                  </Pop>
                ) },
              ]} />
          </Panel>
        )}

        <Panel title="Auto-debits (NACH)" sub="Debits presented to buyers who turned on auto-pay. A failed debit is retried the next day, three times in all." flush>
          <DataTable rows={debits} rowKey={({ d }) => d.id} empty="No auto-debits yet."
            cols={[
              { h: "Invoice", cell: ({ inv }) => inv.invoiceNumber },
              { h: "Attempt", align: "center", cell: ({ d }) => d.attempt },
              { h: "Amount", align: "right", cell: ({ d }) => formatMoney(d.amount) },
              { h: "Status", cell: ({ d }) => <StatusPill status={d.status} /> },
              { h: "Presented", cell: ({ d }) => <span className="font-normal text-muted">{d.presentedAt.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</span> },
              { h: "Note", cell: ({ d }) => <span className="font-normal text-muted">{d.failureReason ?? ""}</span> },
            ]} />
        </Panel>

        <Panel title="Unmatched bank credits" sub="Apply each one to the invoice it pays." flush>
          <DataTable rows={unmatched} rowKey={(c) => c.id} empty="No unmatched credits."
            cols={[
              { h: "Amount", cell: (c) => formatMoney(c.amount) },
              { h: "UTR", cell: (c) => <span className="font-mono text-[13px]">{c.utr}</span> },
              { h: "Account", cell: (c) => <span className="font-mono text-[13px]">{c.accountNumber}</span> },
              { h: "Reason", cell: (c) => <span className="text-muted">{c.reason}</span> },
              { h: "Apply to", align: "right", cell: (c) => (
                <form action={match} className="inline-flex gap-1.5">
                  <input type="hidden" name="creditId" value={c.id} />
                  <select name="invoiceId" className="field-inline !py-1 text-sm">{open.map((o) => <option key={o.id} value={o.id}>{o.no}</option>)}</select>
                  <button className="btn btn-ghost btn-sm">Apply</button>
                </form>
              ) },
            ]} />
        </Panel>
      </div>
    </>
  );
}
