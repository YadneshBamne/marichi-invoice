import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/server/db/client";
import { businesses, financingOffers, invoices } from "@/server/db/schema";
import { requireUser } from "@/server/rbac";
import { assertCan, can } from "@/server/permissions";
import { DD, listEarlyPayments, withdrawEarlyPayment } from "@/server/earlypay/service";
import { quoteEarly } from "@/server/earlypay/quote";
import { submit } from "@/server/approvals/service";
import { DataTable, EmptyState, KV, Notice, PageHead, Panel, Pop, StatusPill } from "@/components/ui/page";
import { formatINR } from "@/lib/money";
import { attempt } from "../../financier/attempt";
import { QuoteForm } from "./quote-form";

export const metadata = { title: "Pay early" };
const PATH = "/buyer/early-payment";
const day = (d: string) => Math.floor(new Date(d).getTime() / 86_400_000);

async function propose(fd: FormData) {
  "use server";
  const u = await requireUser(["buyer"]);
  await attempt(PATH, async () => {
    assertCan(u, "earlypay.prepare");
    const f = z.object({ invoiceId: z.uuid(), discountPct: z.coerce.number() }).parse(Object.fromEntries(fd));
    const discountBps = Math.round(f.discountPct * 100);
    const [inv] = await db.select().from(invoices).where(eq(invoices.id, f.invoiceId));
    if (!inv) throw new Error("invoice not found");
    const q = quoteEarly(inv.amount, Math.max(1, day(inv.dueDate) - day(new Date().toISOString())), discountBps);
    const r = await submit(db, { id: u.id, role: u.role, orgRole: u.orgRole, businessId: u.businessId }, "earlypay.propose", { invoiceId: f.invoiceId, discountBps },
      { summary: `Pay invoice ${inv.invoiceNumber} early: ${formatINR(q.net)} now, saving ${formatINR(q.discount)}`, amount: q.net });
    return r.status === "queued" ? "Sent for approval. An approver in your company will see it under Approvals. Nothing goes to your supplier until they approve." : "Sent to your supplier. They have 72 hours to answer.";
  });
}
async function withdraw(fd: FormData) {
  "use server";
  const u = await requireUser(["buyer"]);
  await attempt(PATH, async () => {
    assertCan(u, "earlypay.prepare");
    await withdrawEarlyPayment(db, { id: u.id, role: u.role, businessId: u.businessId }, z.uuid().parse(fd.get("id")));
    return "Proposal withdrawn.";
  });
}

export default async function EarlyPayment({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const u = await requireUser(["buyer"]);
  const q = await searchParams;
  const may = can(u, "earlypay.prepare");
  const today = day(new Date().toISOString());
  const [list, mine] = await Promise.all([
    db.select({ i: invoices, seller: businesses.legalName }).from(invoices).innerJoin(businesses, eq(businesses.id, invoices.sellerId))
      .where(and(eq(invoices.buyerId, u.businessId!), eq(invoices.status, "eligible"), eq(invoices.disputeFlag, false))),
    listEarlyPayments(db, { buyerId: u.businessId! }),
  ]);
  const taken = new Set((await db.select({ id: financingOffers.invoiceId }).from(financingOffers).where(eq(financingOffers.status, "accepted"))).map((r) => r.id));
  const live = new Set(mine.filter((m) => ["proposed", "accepted"].includes(m.e.status)).map((m) => m.e.invoiceId));
  const open = list.filter((r) => !taken.has(r.i.id) && !live.has(r.i.id) && day(r.i.dueDate) - today >= DD.minDaysEarly);
  return (
    <>
      <PageHead title="Pay early" sub="Pay confirmed invoices before they are due and keep a discount that grows with how early you pay. Your supplier decides whether to accept." />
      {q.ok && <div className="mb-4"><Notice tone="good">{q.ok}</Notice></div>}
      {q.error && <div className="mb-4"><Notice tone="bad">{q.error}</Notice></div>}
      {!may && <div className="mb-4"><Notice tone="warn">Your role can view this page but not propose early payments.</Notice></div>}

      {mine.filter((m) => m.e.status === "accepted").map((m) => (
        <Panel key={m.e.id} title={`Pay ${formatINR(m.e.netAmount)} for invoice ${m.inv.invoiceNumber}`} sub={`Accepted. Pay exactly this amount by ${m.e.expiresAt.toLocaleDateString("en-IN")} or the offer lapses.`} className="mb-5">
          <KV cols={2} rows={[["Amount to pay", formatINR(m.e.netAmount)], ["You save", formatINR(m.e.discountAmount)], ["Account number", m.va ?? "being issued"], ["IFSC", m.ifsc ?? "-"]]} />
        </Panel>
      ))}

      {open.length === 0 ? <EmptyState icon="coins" title="Nothing to pay early right now">Confirmed invoices that are not yet financed, with at least {DD.minDaysEarly} days to run, appear here.</EmptyState> : (
        <Panel title="Invoices you can pay early" flush className="mb-5">
          <DataTable rows={open} rowKey={(r) => r.i.id}
            cols={[
              { h: "Invoice", cell: (r) => r.i.invoiceNumber },
              { h: "Supplier", cell: (r) => r.seller },
              { h: "Amount", align: "right", cell: (r) => formatINR(r.i.amount) },
              { h: "Due", cell: (r) => <>{r.i.dueDate}<span className="block text-xs font-normal text-muted">{day(r.i.dueDate) - today} days away</span></> },
              { h: "", align: "right", cell: (r) => may && (
                <Pop id={`pe-${r.i.id}`} label="Pay early">
                  <QuoteForm amount={r.i.amount.toString()} days={day(r.i.dueDate) - today} minBps={DD.minBps} maxBps={DD.maxBps} feeBps={DD.feeBps} action={propose} invoiceId={r.i.id} cta={can(u, "earlypay.propose") ? "Send to supplier" : "Submit for approval"} />
                </Pop>
              ) },
            ]} />
        </Panel>
      )}

      <Panel title="Your proposals" flush>
        <DataTable rows={mine} rowKey={(m) => m.e.id} empty="You have not proposed an early payment yet."
          cols={[
            { h: "Invoice", cell: (m) => m.inv.invoiceNumber },
            { h: "You pay", align: "right", cell: (m) => formatINR(m.e.netAmount) },
            { h: "You save", align: "right", cell: (m) => formatINR(m.e.discountAmount) },
            { h: "Rate", align: "right", cell: (m) => `${m.e.discountBps / 100}% a year` },
            { h: "Status", cell: (m) => <StatusPill status={m.e.status === "paid" || m.e.status === "accepted" ? "approved" : m.e.status === "proposed" ? "pending" : "rejected"} label={m.e.status} /> },
            { h: "", align: "right", cell: (m) => may && m.e.status === "proposed" && <form action={withdraw}><input type="hidden" name="id" value={m.e.id} /><button className="btn btn-ghost btn-sm">Withdraw</button></form> },
          ]} />
      </Panel>
    </>
  );
}
