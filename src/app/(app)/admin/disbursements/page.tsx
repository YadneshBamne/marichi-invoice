import { revalidatePath } from "next/cache";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/server/db/client";
import { disbursements, financingOffers, invoices } from "@/server/db/schema";
import { requireUser } from "@/server/rbac";
import { approveDisbursement, fundEscrow, retryDisbursement } from "@/server/disbursements/service";
import { ACCOUNTS, balance } from "@/server/ledger/accounts";
import { DataTable, PageHead, Panel, StatusPill } from "@/components/ui/page";
import { Stat } from "@/components/ui/cards";
import { formatMoney, rupeesToPaise } from "@/lib/money";
import { market } from "@/lib/countries";

export const metadata = { title: "Disbursements" };

async function fund(fd: FormData) {
  "use server";
  const u = await requireUser(["ops", "admin"]);
  // The ref makes a double-submit a no-op; it's per submission, generated in the form below.
  await fundEscrow(db, { amount: rupeesToPaise(String(fd.get("amount"))), ref: z.uuid().parse(fd.get("ref")), staffId: u.id, staffRole: u.role });
  revalidatePath("/admin/disbursements");
}
async function act(fd: FormData) {
  "use server";
  const u = await requireUser(["ops", "admin"]);
  const id = z.uuid().parse(fd.get("id"));
  if (fd.get("action") === "approve") await approveDisbursement(db, id, u);
  else await retryDisbursement(db, id, u);
  revalidatePath("/admin/disbursements");
}

export default async function Disbursements() {
  await requireUser(["ops", "admin"]);
  const [escrow, rows] = await Promise.all([
    balance(db, ACCOUNTS.escrow),
    db.select({ d: disbursements, inv: invoices }).from(disbursements)
      .innerJoin(financingOffers, eq(financingOffers.id, disbursements.offerId))
      .innerJoin(invoices, eq(invoices.id, financingOffers.invoiceId)).orderBy(desc(disbursements.createdAt)).limit(100),
  ]);
  const waiting = rows.filter((r) => r.d.status === "pending" && r.d.needsApproval && !r.d.approvedAt).length;
  const failed = rows.filter((r) => r.d.status === "failed").length;

  return (
    <>
      <PageHead title="Disbursements" sub="Fund escrow, approve large payouts, and retry failed ones. Money only leaves escrow once the funds are there." />
      <div className="mb-5 grid gap-4 sm:grid-cols-3">
        <Stat hero label="Escrow balance" value={formatMoney(escrow)} note="available for payouts" />
        <Stat label="Awaiting approval" value={String(waiting)} note="second person must approve" tone={waiting ? "warn" : undefined} />
        <Stat label="Failed" value={String(failed)} note={failed ? "retry or investigate" : "none"} tone={failed ? "bad" : "good"} />
      </div>

      <div className="grid gap-5 xl:grid-cols-[1fr_20rem]">
        <Panel title="Payouts" sub={`Latest ${rows.length}`} flush>
          <DataTable rows={rows} rowKey={(r) => r.d.id} empty="No disbursements yet."
            cols={[
              { h: "Invoice", cell: ({ inv }) => inv.invoiceNumber },
              { h: "Amount", align: "right", cell: ({ d }) => formatMoney(d.amount) },
              { h: "Status", cell: ({ d }) => <span className="flex flex-wrap items-center gap-1.5"><StatusPill status={d.status} />{d.needsApproval && !d.approvedAt && d.status === "pending" && <StatusPill status="pending" label="needs approval" />}</span> },
              { h: "Rail", cell: ({ d }) => d.rail ?? <span className="text-faint">–</span> },
              { h: "Note", cell: ({ d }) => <span className="text-muted">{d.failureReason ?? ""}</span> },
              { h: "", align: "right", cell: ({ d }) => (
                <form action={act} className="inline">
                  <input type="hidden" name="id" value={d.id} />
                  {d.status === "pending" && d.needsApproval && !d.approvedAt && <button name="action" value="approve" className="btn btn-primary btn-sm">Approve</button>}
                  {d.status === "failed" && <button name="action" value="retry" className="btn btn-ghost btn-sm">Retry</button>}
                </form>
              ) },
            ]} />
        </Panel>

        <Panel title="Fund escrow" sub="Record money moved into the escrow account.">
          <form action={fund} className="space-y-3">
            <input type="hidden" name="ref" value={crypto.randomUUID()} />
            <label className="block text-sm font-medium">Amount ({market().currency.symbol})<input name="amount" inputMode="decimal" placeholder="e.g. 10,00,000" required className="field font-normal" /></label>
            <button className="btn btn-primary w-full">Record funding</button>
          </form>
        </Panel>
      </div>
    </>
  );
}
