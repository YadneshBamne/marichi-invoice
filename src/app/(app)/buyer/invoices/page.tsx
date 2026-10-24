import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/server/db/client";
import { businesses, invoiceConfirmations, invoices, virtualAccounts } from "@/server/db/schema";
import { after } from "next/server";
import { requireUser } from "@/server/rbac";
import { assertCan, can } from "@/server/permissions";
import { DataTable, EmptyState, PageHead, Panel, ReviewCard, StatusPill, Pop } from "@/components/ui/page";
import { respondToInvoice } from "@/server/confirmations/service";
import { underwriteInvoice } from "@/server/underwriting/service";
import { generateOffer } from "@/server/offers/service";
import { redirect } from "next/navigation";
import { raiseDispute } from "@/server/support/disputes";
import { formatINR, rupeesToPaise } from "@/lib/money";
import { myMandate } from "@/server/collections/nach";
import { maskTail } from "@/server/crypto";
import { Autopay } from "./autopay";

const Form = z.object({
  invoiceId: z.uuid(),
  decision: z.enum(["confirm", "dispute", "clarify"]),
  note: z.string().optional(),
});

async function respond(fd: FormData) {
  "use server";
  const u = await requireUser(["buyer"]);
  assertCan(u, "invoice.confirm");
  const h = await headers();
  const { status } = await respondToInvoice(db, {
    ...Form.parse(Object.fromEntries(fd)),
    actor: {
      id: u.id, email: u.email, role: u.role, businessId: u.businessId,
      ip: h.get("x-forwarded-for")?.split(",")[0].trim(), userAgent: h.get("user-agent") ?? undefined,
    },
  });
  const { invoiceId } = Form.parse(Object.fromEntries(fd));
  // Best effort so the seller sees a decision fast; the worker retries if e.g. the bureau is down.
  if (status === "eligible") {
    // The bureau pull and offer take several seconds: run them after the response so the buyer is not kept waiting.
    after(async () => {
      try {
        const d = await underwriteInvoice(db, invoiceId);
        if (d.decision === "approved") await generateOffer(db, invoiceId);
      } catch (e) {
        console.error("[underwrite]", (e as Error).message);
      }
    });
  }
  revalidatePath("/buyer/invoices");
}

async function dispute(fd: FormData) {
  "use server";
  const u = await requireUser(["buyer"]);
  assertCan(u, "invoice.confirm");
  const amount = String(fd.get("amount") ?? "").trim();
  const t = await raiseDispute(db, {
    invoiceId: z.uuid().parse(fd.get("invoiceId")), actor: u, reason: String(fd.get("reason") ?? ""), disputedAmount: amount ? rupeesToPaise(amount) : undefined,
  });
  redirect(`/support/${t.id}`);
}

export default async function BuyerInvoices() {
  const u = await requireUser(["buyer"]);
  const [mandateRow, rows, payables] = await Promise.all([
    myMandate(db, u.businessId!),
    db.select({ i: invoices, seller: businesses.legalName, c: invoiceConfirmations }).from(invoices)
      .innerJoin(businesses, eq(businesses.id, invoices.sellerId)).leftJoin(invoiceConfirmations, eq(invoiceConfirmations.invoiceId, invoices.id))
      .where(eq(invoices.buyerId, u.businessId!)).orderBy(desc(invoices.createdAt)),
    db.select({ i: invoices, seller: businesses.legalName, va: virtualAccounts }).from(invoices)
      .innerJoin(businesses, eq(businesses.id, invoices.sellerId)).innerJoin(virtualAccounts, eq(virtualAccounts.invoiceId, invoices.id))
      .where(and(eq(invoices.buyerId, u.businessId!), inArray(invoices.status, ["financed", "due", "overdue"]))).orderBy(asc(invoices.dueDate)),
  ]);
  const pending = rows.filter((r) => r.i.status === "sent_for_confirmation");
  const done = rows.filter((r) => r.i.status !== "sent_for_confirmation" && r.c);
  const lead = can(u, "invoice.confirm");
  const mandate = mandateRow && { id: mandateRow.id, status: mandateRow.status, maskedAccount: maskTail(mandateRow.accountNumber), ifsc: mandateRow.ifsc, maxLabel: formatINR(mandateRow.maxAmount) };

  return (
    <>
      <PageHead title="Invoices" sub="Confirm invoices from your suppliers, and pay the ones already financed to the account shown." />
      <div className="space-y-5">
        <section>
          <h2 className="mb-3 text-[15px] font-semibold">Waiting for your confirmation <span className="font-normal text-muted">({pending.length})</span></h2>
          {pending.length === 0 ? <EmptyState title="Nothing pending">Invoices from your suppliers will appear here to confirm.</EmptyState> : (
            <div className="grid gap-5 xl:grid-cols-2">
              {pending.map(({ i, seller, c }) => (
                <ReviewCard key={i.id} title={`${seller}  ${i.invoiceNumber}`}
                  meta={<><span>Dated {i.invoiceDate}</span><span>due {i.dueDate}</span>{i.poReference && <span>PO {i.poReference}</span>}</>}
                  aside={<p className="text-lg font-semibold">{formatINR(i.amount)}</p>}
                  actions={!lead ? <p className="text-xs text-s-600">Only an approver or the owner can confirm an invoice. Ask one of them.</p> : (
                    <form action={respond} className="flex flex-wrap items-center gap-2">
                      <input type="hidden" name="invoiceId" value={i.id} />
                      <input name="note" placeholder="Note (required to dispute or ask)" className="field-inline min-w-48 flex-1 !py-1.5 text-sm" />
                      <button name="decision" value="confirm" className="btn btn-primary btn-sm">Confirm</button>
                      <button name="decision" value="clarify" className="btn btn-ghost btn-sm">Ask a question</button>
                      <button name="decision" value="dispute" className="btn btn-danger btn-sm">Dispute</button>
                    </form>
                  )}>
                  {c?.status === "clarification" && <p className="mb-2 text-s-600">You asked: {c.note}</p>}
                  <p className="text-muted">By confirming you acknowledge that this invoice is genuine and payable on the due date to the designated collection account.</p>
                </ReviewCard>
              ))}
            </div>
          )}
        </section>

        <Autopay mandate={mandate} canManage={lead} mock={(process.env.INTEGRATIONS_MODE ?? "mock") === "mock"} />

        {payables.length > 0 && (
          <Panel title="Payments due" sub="These invoices were assigned to Marichi Labs. Pay only to the account shown." flush>
            <DataTable rows={payables} rowKey={({ i }) => i.id}
              cols={[
                { h: "Invoice", cell: ({ i, seller }) => <>{i.invoiceNumber}<span className="block text-[13px] font-normal text-muted">{seller}</span></> },
                { h: "Amount", align: "right", cell: ({ i }) => formatINR(i.amount) },
                { h: "Due", cell: ({ i }) => <span className="flex items-center gap-2">{i.dueDate}{i.status === "overdue" && <StatusPill status="overdue" />}</span> },
                { h: "Pay to", cell: ({ va }) => <span className="font-mono text-[13px] font-normal">{va.accountNumber}<span className="block text-xs text-muted">IFSC {va.ifsc}</span></span> },
                { h: "Reference", cell: ({ i }) => <span className="font-mono text-[13px] font-normal">{i.invoiceNumber}</span> },
                { h: "", align: "right", cell: ({ i }) => lead && (
                  <Pop id={`dp-${i.id}`} label="Dispute" cls="btn btn-ghost btn-sm">
                    <form action={dispute} className="space-y-2">
                      <input type="hidden" name="invoiceId" value={i.id} />
                      <input name="reason" placeholder="What is wrong?" required className="field !py-2 text-sm" />
                      <input name="amount" inputMode="decimal" placeholder="Disputed amount (blank = all)" className="field !py-2 text-sm" />
                      <button className="btn btn-danger btn-sm w-full">Raise dispute</button>
                    </form>
                  </Pop>
                ) },
              ]} />
          </Panel>
        )}

        {done.length > 0 && (
          <Panel title="Already responded" flush>
            <DataTable rows={done} rowKey={({ i }) => i.id}
              cols={[
                { h: "Invoice", cell: ({ i, seller }) => <>{i.invoiceNumber}<span className="block text-[13px] font-normal text-muted">{seller}</span></> },
                { h: "Amount", align: "right", cell: ({ i }) => formatINR(i.amount) },
                { h: "Your response", cell: ({ c }) => <span className="flex items-center gap-2"><StatusPill status={c!.status} />{c!.method === "deemed" && <span className="text-xs font-normal text-muted">deemed</span>}</span> },
              ]} />
          </Panel>
        )}
      </div>
    </>
  );
}
