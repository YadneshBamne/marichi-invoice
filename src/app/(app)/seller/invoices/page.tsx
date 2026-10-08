import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/server/db/client";
import { businesses, buyerSellerRelationships, financingOffers, invoices, underwritingDecisions } from "@/server/db/schema";
import { acceptOffer, expireOffers, generateOffer, rejectOffer } from "@/server/offers/service";
import { priceOffer } from "@/server/offers/pricing";
import { requireUser } from "@/server/rbac";
import { assertCan, can } from "@/server/permissions";
import { createInvoice } from "@/server/invoices/service";
import { sendForConfirmation } from "@/server/confirmations/service";
import { putDocument } from "@/server/vault";
import { Card, Empty, PageHead, Pill, type Tone } from "@/components/ui/cards";
import { formatINR, rupeesToPaise } from "@/lib/money";

const Form = z.object({
  buyerId: z.uuid(),
  invoiceNumber: z.string().min(1).max(40),
  invoiceDate: z.string(),
  dueDate: z.string(),
  amount: z.string(),
  irn: z.string().optional(),
  poReference: z.string().optional(),
});

async function upload(fd: FormData) {
  "use server";
  const u = await requireUser(["seller"]);
  assertCan(u, "invoice.upload");
  const file = fd.get("file");
  if (!(file instanceof File)) throw new Error("invoice file is required");
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
  revalidatePath("/seller/invoices");
}

const OfferForm = z.object({ offerId: z.uuid(), action: z.enum(["accept", "reject"]) });
async function answerOffer(fd: FormData) {
  "use server";
  const u = await requireUser(["seller"]);
  assertCan(u, "offer.answer");
  const f = OfferForm.parse(Object.fromEntries(fd));
  const actor = { id: u.id, role: u.role, businessId: u.businessId };
  await (f.action === "accept" ? acceptOffer : rejectOffer)(db, f.offerId, actor);
  revalidatePath("/seller/invoices");
}
async function newOffer(fd: FormData) {
  "use server";
  const u = await requireUser(["seller"]);
  assertCan(u, "invoice.upload");
  const invoiceId = z.uuid().parse(fd.get("invoiceId"));
  const [inv] = await db.select({ s: invoices.sellerId }).from(invoices).where(eq(invoices.id, invoiceId));
  if (inv?.s !== u.businessId) throw new Error("FORBIDDEN");
  await generateOffer(db, invoiceId);
  revalidatePath("/seller/invoices");
}

const input = "field font-normal";
const STATUS: Record<string, Tone> = { paid: "good", financed: "info", due: "warn", overdue: "bad", disputed: "bad", rejected: "bad", written_off: "bad", eligible: "good", confirmed: "good" };

export default async function Invoices() {
  const u = await requireUser(["seller"]);
  await expireOffers(db);
  const commit = can(u, "offer.answer");
  const [buyers, rows] = await Promise.all([
    db.select({ id: businesses.id, name: businesses.legalName }).from(buyerSellerRelationships)
      .innerJoin(businesses, eq(businesses.id, buyerSellerRelationships.buyerId)).where(eq(buyerSellerRelationships.sellerId, u.businessId!)),
    db.select().from(invoices).where(eq(invoices.sellerId, u.businessId!)).orderBy(desc(invoices.createdAt)),
  ]);
  const ids = rows.map((r) => r.id);
  const [decisions, allOffers] = ids.length ? await Promise.all([
    db.select().from(underwritingDecisions).where(inArray(underwritingDecisions.invoiceId, ids)),
    db.select().from(financingOffers).where(inArray(financingOffers.invoiceId, ids)).orderBy(desc(financingOffers.createdAt)),
  ]) : [[], []];
  const decisionOf = new Map(decisions.map((d) => [d.invoiceId, d]));
  const offerOf = new Map<string, (typeof allOffers)[number]>();
  for (const o of allOffers) if (!offerOf.has(o.invoiceId)) offerOf.set(o.invoiceId, o); // newest first
  const actionable = rows.filter((r) => decisionOf.has(r.id));

  return (
    <div className="text-sm">
      <PageHead title="Invoices" sub="Upload invoices, follow them through confirmation, and answer offers." />

      <Card title={`All invoices (${rows.length})`} className="mb-5">
        {rows.length === 0 ? <Empty>No invoices yet. Upload your first one below.</Empty> : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead><tr><th>No.</th><th>Amount</th><th>Due</th><th>Status</th><th>e-Invoice</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="font-semibold">{r.invoiceNumber}</td><td>{formatINR(r.amount)}</td><td>{r.dueDate}</td>
                    <td><Pill tone={STATUS[r.status] ?? "neutral"}>{r.status.replaceAll("_", " ")}</Pill></td><td className="text-muted">{r.irnStatus}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {actionable.map((r) => {
        const d = decisionOf.get(r.id)!;
        const o = offerOf.get(r.id);
        const p = o && priceOffer({ amount: r.amount, advanceBps: d.advanceRateBps, discountBps: o.discountBps, tenorDays: o.tenorDays });
        return (
          <Card key={r.id} title={`Invoice ${r.invoiceNumber} · ${formatINR(r.amount)}`} className="mb-5">
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
                  <dt className="text-muted">Advance ({d.advanceRateBps / 100}%)</dt><dd className="text-right">{formatINR(o.advanceAmount)}</dd>
                  <dt className="text-muted">Processing fee (upfront)</dt><dd className="text-right">− {formatINR(o.feeAmount)}</dd>
                  <dt className="border-t border-hair pt-2 font-semibold">You receive now</dt><dd className="border-t border-hair pt-2 text-right text-lg font-semibold">{formatINR(p.netDisbursal)}</dd>
                  <dt className="text-muted">Discount for {o.tenorDays} days ({o.discountBps / 100}% p.a.)</dt><dd className="text-right">{formatINR(o.expectedDiscount)}</dd>
                  <dt className="text-muted">All-in effective rate</dt><dd className="text-right">{(p.effectiveAprBps / 100).toFixed(2)}% p.a.</dd>
                  <dt className="text-muted">Recourse</dt><dd className="text-right">{o.recourse ? "Yes: you repay if the buyer doesn't" : "No"}</dd>
                </dl>
                <div className="flex flex-col justify-end gap-3">
                  {o.status === "open" && (commit ? (
                    <form action={answerOffer} className="flex flex-wrap items-center gap-2">
                      <input type="hidden" name="offerId" value={o.id} />
                      <button name="action" value="accept" className="btn btn-primary">Accept offer</button>
                      <button name="action" value="reject" className="btn btn-ghost">Decline</button>
                      <span className="w-full text-xs text-muted">Valid until {o.expiresAt.toLocaleString("en-IN")}</span>
                    </form>
                  ) : <p className="max-w-xs rounded-lg bg-s-100 p-3 text-xs text-s-600">Accepting an offer commits the company. Ask a manager or the owner to answer it. Valid until {o.expiresAt.toLocaleString("en-IN")}.</p>)}
                  {o.status === "accepted" && <p className="text-p-700">Accepted. Next: <a className="font-semibold underline" href="/seller/agreements">sign the agreement</a>.</p>}
                  {(o.status === "expired" || o.status === "rejected") && r.status === "eligible" && (
                    <form action={newOffer} className="flex items-center gap-3"><input type="hidden" name="invoiceId" value={r.id} /><span className="text-muted">Offer {o.status}.</span><button className="btn btn-ghost btn-sm">Get a new offer</button></form>
                  )}
                </div>
              </div>
            )}
          </Card>
        );
      })}

      {buyers.length === 0 ? (
        <p className="rounded-card bg-s-100 p-4 text-s-600">You need a verified buyer first. <a className="font-semibold underline" href="/seller/buyers">Invite your buyer</a></p>
      ) : (
        <Card title="Upload an invoice" tour="upload">
          <form action={upload} className="grid gap-4 sm:grid-cols-2">
            <label className="block font-medium sm:col-span-2">Buyer
              <select name="buyerId" className={input}>{buyers.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
            </label>
            <label className="block font-medium">Invoice number<input name="invoiceNumber" required className={input} /></label>
            <label className="block font-medium">Amount (₹, incl. tax)<input name="amount" inputMode="decimal" required className={input} /></label>
            <label className="block font-medium">Invoice date<input name="invoiceDate" type="date" required className={input} /></label>
            <label className="block font-medium">Due date<input name="dueDate" type="date" required className={input} /></label>
            <label className="block font-medium">e-Invoice IRN <span className="font-normal text-faint">(if issued)</span><input name="irn" className={input} /></label>
            <label className="block font-medium">PO reference<input name="poReference" className={input} /></label>
            <label className="block font-medium sm:col-span-2">Invoice file <span className="font-normal text-faint">(PDF, PNG or JPG, up to 5 MB)</span><input name="file" type="file" accept="application/pdf,image/png,image/jpeg" required className={`${input} file:mr-3 file:rounded-full file:border-0 file:bg-p-100 file:px-4 file:py-1.5 file:font-semibold file:text-p-700`} /></label>
            <div className="sm:col-span-2"><button className="btn btn-primary">Submit invoice</button></div>
          </form>
        </Card>
      )}
    </div>
  );
}
