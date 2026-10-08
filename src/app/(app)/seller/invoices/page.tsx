import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/server/db/client";
import { businesses, buyerSellerRelationships, financingOffers, invoices, underwritingDecisions } from "@/server/db/schema";
import { acceptOffer, acceptOffers, expireOffers, generateOffer, rejectOffer, repriceOffer } from "@/server/offers/service";
import { describeOffer } from "@/server/offers/pricing";
import { requireUser } from "@/server/rbac";
import { assertCan, can } from "@/server/permissions";
import { createInvoice } from "@/server/invoices/service";
import { issueCreditNote, listCreditNotes } from "@/server/invoices/credit-notes";
import { sendForConfirmation } from "@/server/confirmations/service";
import { putDocument } from "@/server/vault";
import { DataTable, EmptyState, Field, Notice, PageHead, Panel, StatusPill } from "@/components/ui/page";
import { formatINR, rupeesToPaise } from "@/lib/money";

export const metadata = { title: "Invoices" };

const Form = z.object({
  buyerId: z.uuid(),
  invoiceNumber: z.string().min(1).max(40),
  invoiceDate: z.string(),
  dueDate: z.string(),
  amount: z.string(),
  irn: z.string().optional(),
  poReference: z.string().optional(),
});

/** Run an action; on a business-rule error come back to the page with the message instead of an error screen. */
async function attempt(fn: () => Promise<string | void>) {
  let msg: string | void;
  try { msg = await fn(); } catch (e) {
    redirect(`/seller/invoices?error=${encodeURIComponent(e instanceof Error ? e.message : "Something went wrong")}`);
  }
  revalidatePath("/seller/invoices");
  redirect(msg ? `/seller/invoices?ok=${encodeURIComponent(msg)}` : "/seller/invoices");
}

async function upload(fd: FormData) {
  "use server";
  const u = await requireUser(["seller"]);
  await attempt(async () => {
    assertCan(u, "invoice.upload");
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) throw new Error("choose the invoice file to upload");
    const f = Form.parse(Object.fromEntries(fd));
    const doc = await putDocument(Buffer.from(await file.arrayBuffer()), file.type);
    const created = await createInvoice(db, {
      sellerId: u.businessId!, buyerId: f.buyerId, invoiceNumber: f.invoiceNumber,
      invoiceDate: f.invoiceDate, dueDate: f.dueDate, amount: rupeesToPaise(f.amount),
      irn: f.irn?.trim() || undefined, poReference: f.poReference || undefined,
      contentHash: doc.hash, documentRef: doc.ref,
    });
    // Telling the buyer happens after the response so the seller is not kept waiting; the worker dispatches it if this fails.
    if (created.status === "validated") after(() => sendForConfirmation(db, created.id).catch((e) => console.error("[confirm]", e.message)));
    return "Invoice uploaded. Your buyer has been asked to confirm it.";
  });
}

const OfferForm = z.object({ offerId: z.uuid(), action: z.enum(["accept", "reject"]) });
async function answerOffer(fd: FormData) {
  "use server";
  const u = await requireUser(["seller"]);
  await attempt(async () => {
    assertCan(u, "offer.answer");
    const f = OfferForm.parse(Object.fromEntries(fd));
    await (f.action === "accept" ? acceptOffer : rejectOffer)(db, f.offerId, { id: u.id, role: u.role, businessId: u.businessId });
    return f.action === "accept" ? "Offer accepted. Sign the agreement to receive the funds." : "Offer declined.";
  });
}
async function acceptAll(fd: FormData) {
  "use server";
  const u = await requireUser(["seller"]);
  await attempt(async () => {
    assertCan(u, "offer.answer");
    const ids = z.array(z.uuid()).min(1).parse(fd.getAll("offerId"));
    const r = await acceptOffers(db, ids, { id: u.id, role: u.role, businessId: u.businessId });
    const ok = r.filter((x) => x.ok).length, bad = r.filter((x) => !x.ok);
    if (ok === 0) throw new Error(bad[0]?.error ?? "no offers could be accepted");
    return `${ok} offer${ok === 1 ? "" : "s"} accepted${bad.length ? `; ${bad.length} could not be (${bad[0].error})` : ""}. Sign the agreements to receive the funds.`;
  });
}
async function reprice(fd: FormData) {
  "use server";
  const u = await requireUser(["seller"]);
  await attempt(async () => {
    assertCan(u, "offer.reprice");
    const o = await repriceOffer(db, z.uuid().parse(fd.get("offerId")), { id: u.id, role: u.role, businessId: u.businessId }, rupeesToPaise(String(fd.get("advance") ?? "")));
    return `Offer updated: you will receive ${formatINR(describeOffer(o).netDisbursal)} now.`;
  });
}
async function newOffer(fd: FormData) {
  "use server";
  const u = await requireUser(["seller"]);
  await attempt(async () => {
    assertCan(u, "invoice.upload");
    const invoiceId = z.uuid().parse(fd.get("invoiceId"));
    const [inv] = await db.select({ s: invoices.sellerId }).from(invoices).where(eq(invoices.id, invoiceId));
    if (inv?.s !== u.businessId) throw new Error("FORBIDDEN");
    await generateOffer(db, invoiceId);
    return "A new offer is ready.";
  });
}
async function creditNote(fd: FormData) {
  "use server";
  const u = await requireUser(["seller"]);
  await attempt(async () => {
    assertCan(u, "creditnote.issue");
    const r = await issueCreditNote(db, { id: u.id, role: u.role, businessId: u.businessId }, {
      invoiceId: z.uuid().parse(fd.get("invoiceId")), amount: rupeesToPaise(String(fd.get("amount") ?? "")), reason: String(fd.get("reason") ?? ""),
    });
    return `Credit note ${r.creditNote.number} issued. The invoice is now ${formatINR(r.newAmount)}.`;
  });
}

const input = "field font-normal";
const CREDITABLE = ["uploaded", "validated", "sent_for_confirmation", "confirmed", "eligible", "financed", "due", "overdue"];

export default async function Invoices({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const u = await requireUser(["seller"]);
  const q = await searchParams;
  await expireOffers(db);
  const commit = can(u, "offer.answer");
  const [buyers, rows] = await Promise.all([
    db.select({ id: businesses.id, name: businesses.legalName }).from(buyerSellerRelationships)
      .innerJoin(businesses, eq(businesses.id, buyerSellerRelationships.buyerId)).where(eq(buyerSellerRelationships.sellerId, u.businessId!)),
    db.select().from(invoices).where(eq(invoices.sellerId, u.businessId!)).orderBy(desc(invoices.createdAt)),
  ]);
  const ids = rows.map((r) => r.id);
  const [decisions, allOffers, notes] = await Promise.all([
    ids.length ? db.select().from(underwritingDecisions).where(inArray(underwritingDecisions.invoiceId, ids)) : [],
    ids.length ? db.select().from(financingOffers).where(inArray(financingOffers.invoiceId, ids)).orderBy(desc(financingOffers.createdAt)) : [],
    listCreditNotes(db, ids),
  ]);
  const decisionOf = new Map(decisions.map((d) => [d.invoiceId, d]));
  const offerOf = new Map<string, (typeof allOffers)[number]>();
  for (const o of allOffers) if (!offerOf.has(o.invoiceId)) offerOf.set(o.invoiceId, o); // newest first
  const creditOf = new Map<string, bigint>();
  for (const n of notes) creditOf.set(n.invoiceId, (creditOf.get(n.invoiceId) ?? 0n) + n.amount);
  const actionable = rows.filter((r) => decisionOf.has(r.id));
  const openOffers = actionable.map((r) => offerOf.get(r.id)).filter((o): o is NonNullable<typeof o> => !!o && o.status === "open");
  const bulkNet = openOffers.reduce((a, o) => a + describeOffer(o).netDisbursal, 0n);

  return (
    <div className="text-sm">
      <PageHead title="Invoices" sub="Upload invoices, follow them through confirmation, answer offers, and issue credit notes." />
      {q.ok && <div className="mb-4"><Notice tone="good">{q.ok}</Notice></div>}
      {q.error && <div className="mb-4"><Notice tone="bad">{q.error}</Notice></div>}

      {openOffers.length >= 2 && (
        <form action={acceptAll} className="mb-5 flex flex-wrap items-center justify-between gap-4 rounded-card bg-p-100 p-5 ring-1 ring-p-400">
          {openOffers.map((o) => <input key={o.id} type="hidden" name="offerId" value={o.id} />)}
          <div><p className="font-semibold">{openOffers.length} offers are waiting for you</p><p className="text-muted">Accept them together to receive {formatINR(bulkNet)} in total once signed. Each offer stays its own agreement.</p></div>
          {commit ? <button className="btn btn-primary">Accept all {openOffers.length}</button> : <p className="max-w-xs text-xs text-s-600">Ask a manager or the owner to accept offers.</p>}
        </form>
      )}

      <Panel title={`All invoices (${rows.length})`} className="mb-5" flush>
        <DataTable rows={rows} rowKey={(r) => r.id} empty="No invoices yet. Upload your first one below."
          cols={[
            { h: "No.", cell: (r) => r.invoiceNumber },
            { h: "Amount", align: "right", cell: (r) => <>{formatINR(r.amount)}{creditOf.has(r.id) && <span className="block text-xs font-normal text-muted">after {formatINR(creditOf.get(r.id)!)} credit</span>}</> },
            { h: "Due", cell: (r) => r.dueDate },
            { h: "Status", cell: (r) => <StatusPill status={r.status} /> },
            { h: "e-Invoice", cell: (r) => <span className="font-normal text-muted">{r.irnStatus}</span> },
            { h: "", align: "right", cell: (r) => can(u, "creditnote.issue") && CREDITABLE.includes(r.status) && !r.disputeFlag && (
              <details className="relative inline-block text-left">
                <summary className="btn btn-ghost btn-sm cursor-pointer list-none">Credit note</summary>
                <form action={creditNote} className="absolute right-0 z-10 mt-2 w-80 space-y-2 rounded-card bg-card p-4 shadow-pop">
                  <input type="hidden" name="invoiceId" value={r.id} />
                  <p className="text-xs text-muted">Reduces what {r.invoiceNumber} is worth. Your buyer is told, and any open offer is withdrawn.</p>
                  <input name="amount" inputMode="decimal" placeholder="Credit amount (₹)" required className="field !py-2 text-sm" />
                  <input name="reason" placeholder="Reason, e.g. goods returned" required className="field !py-2 text-sm" />
                  <button className="btn btn-primary btn-sm w-full">Issue credit note</button>
                </form>
              </details>
            ) },
          ]} />
      </Panel>

      {actionable.map((r) => {
        const d = decisionOf.get(r.id)!;
        const o = offerOf.get(r.id);
        const p = o && describeOffer(o);
        const maxAdvance = (r.amount * BigInt(d.advanceRateBps)) / 10_000n;
        return (
          <Panel key={r.id} title={`Invoice ${r.invoiceNumber} · ${formatINR(r.amount)}`} className="mb-5">
            {d.decision === "declined" && (
              <div>
                <p className="font-medium text-r-600">We couldn&apos;t finance this invoice. Reasons:</p>
                <ul className="mt-1 list-disc pl-5 text-muted">{(d.reasons as { code: string; text: string }[]).filter((x) => x.code !== "GRADE").map((x) => <li key={x.code}>{x.text}</li>)}</ul>
              </div>
            )}
            {d.decision === "referred" && <p className="text-s-600">Under review by our credit team.</p>}
            {d.decision === "approved" && !o && <p className="text-muted">Preparing your offer…</p>}
            {o && p && (
              <div className="grid gap-5 lg:grid-cols-[1fr_auto]">
                <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 sm:max-w-lg sm:gap-x-8">
                  <dt className="text-muted">Advance{o.advanceAmount < maxAdvance ? " (part of the invoice)" : ` (${d.advanceRateBps / 100}%)`}</dt><dd className="text-right">{formatINR(o.advanceAmount)}</dd>
                  <dt className="text-muted">Processing fee (upfront)</dt><dd className="text-right">− {formatINR(o.feeAmount)}</dd>
                  <dt className="border-t border-hair pt-2 font-semibold">You receive now</dt><dd className="border-t border-hair pt-2 text-right text-lg font-semibold">{formatINR(p.netDisbursal)}</dd>
                  <dt className="text-muted">Discount for {o.tenorDays} days ({o.discountBps / 100}% p.a.)</dt><dd className="text-right">{formatINR(o.expectedDiscount)}</dd>
                  <dt className="text-muted">All-in effective rate</dt><dd className="text-right">{(p.effectiveAprBps / 100).toFixed(2)}% p.a.</dd>
                  <dt className="text-muted">Recourse</dt><dd className="text-right">{o.recourse ? "Yes: you repay if the buyer doesn't" : "No"}</dd>
                </dl>
                <div className="flex flex-col justify-end gap-3">
                  {o.status === "open" && (commit ? (
                    <>
                      <form action={answerOffer} className="flex flex-wrap items-center gap-2">
                        <input type="hidden" name="offerId" value={o.id} />
                        <button name="action" value="accept" className="btn btn-primary">Accept offer</button>
                        <button name="action" value="reject" className="btn btn-ghost">Decline</button>
                        <span className="w-full text-xs text-muted">Valid until {o.expiresAt.toLocaleString("en-IN")}</span>
                      </form>
                      <details className="text-sm">
                        <summary className="cursor-pointer font-semibold text-p-700">Need less? Finance only part of it</summary>
                        <form action={reprice} className="mt-2 flex flex-wrap items-center gap-2">
                          <input type="hidden" name="offerId" value={o.id} />
                          <input name="advance" inputMode="decimal" required placeholder={`Advance up to ${formatINR(maxAdvance)}`} className="field-inline w-56 !py-1.5 text-sm" />
                          <button className="btn btn-ghost btn-sm">Update offer</button>
                          <span className="w-full text-xs text-muted">A smaller advance means a smaller fee and less discount. You receive the rest when the buyer pays.</span>
                        </form>
                      </details>
                    </>
                  ) : <p className="max-w-xs rounded-lg bg-s-100 p-3 text-xs text-s-600">Accepting an offer commits the company. Ask a manager or the owner to answer it. Valid until {o.expiresAt.toLocaleString("en-IN")}.</p>)}
                  {o.status === "accepted" && <p className="text-p-700">Accepted. Next: <a className="font-semibold underline" href="/seller/agreements">sign the agreement</a>.</p>}
                  {(o.status === "expired" || o.status === "rejected") && r.status === "eligible" && (
                    <form action={newOffer} className="flex items-center gap-3"><input type="hidden" name="invoiceId" value={r.id} /><span className="text-muted">Offer {o.status}.</span><button className="btn btn-ghost btn-sm">Get a new offer</button></form>
                  )}
                </div>
              </div>
            )}
          </Panel>
        );
      })}

      {buyers.length === 0 ? (
        <EmptyState icon="users" title="Add a buyer first">You need a linked and verified buyer before you can upload an invoice. <a className="font-semibold text-p-700 underline" href="/seller/buyers">Add your buyer</a></EmptyState>
      ) : (
        <Panel title="Upload an invoice" tour="upload">
          <form action={upload} className="grid gap-4 sm:grid-cols-2">
            <Field label="Buyer" className="sm:col-span-2"><select name="buyerId" className={input}>{buyers.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
            <Field label="Invoice number"><input name="invoiceNumber" required className={input} /></Field>
            <Field label="Amount (₹, incl. tax)"><input name="amount" inputMode="decimal" required className={input} /></Field>
            <Field label="Invoice date"><input name="invoiceDate" type="date" required className={input} /></Field>
            <Field label="Due date"><input name="dueDate" type="date" required className={input} /></Field>
            <Field label="e-Invoice IRN (if issued)"><input name="irn" className={input} /></Field>
            <Field label="PO reference"><input name="poReference" className={input} /></Field>
            <Field label="Invoice file (PDF, PNG or JPG, up to 4 MB)" className="sm:col-span-2"><input name="file" type="file" accept="application/pdf,image/png,image/jpeg" required className={`${input} file:mr-3 file:rounded-full file:border-0 file:bg-p-100 file:px-4 file:py-1.5 file:font-semibold file:text-p-700`} /></Field>
            <div className="sm:col-span-2"><button className="btn btn-primary">Submit invoice</button></div>
          </form>
        </Panel>
      )}
    </div>
  );
}
