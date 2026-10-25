import { revalidatePath } from "next/cache";
import { eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/server/db/client";
import { invoices, unmatchedCredits, invoiceCollections } from "@/server/db/schema";
import { requireUser } from "@/server/rbac";
import { delinquencyReport, matchUnmatched, writeOff } from "@/server/collections/service";
import { recentDebits } from "@/server/collections/nach";
import { DataTable, PageHead, Panel, StatusPill } from "@/components/ui/page";
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

export default async function Collections() {
  const u = await requireUser(["ops", "admin"]);
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
              { h: "", align: "right", cell: (r) => u.role === "admin" && r.bucket === "90+" && (
                <form action={writeOffAction} className="inline-flex gap-1.5">
                  <input type="hidden" name="invoiceId" value={r.invoiceId} />
                  <input name="note" placeholder="Reason" required className="field-inline w-28 !py-1 text-sm" />
                  <button className="btn btn-ghost btn-sm text-r-600">Write off</button>
                </form>
              ) },
            ]} />
        </Panel>

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
