import { redirect } from "next/navigation";
import { after } from "next/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/server/db/client";
import { businesses, buyerSellerRelationships, invoices } from "@/server/db/schema";
import { requireUser } from "@/server/rbac";
import { assertCan } from "@/server/permissions";
import { CROSS, createExportInvoice, lockRate } from "@/server/crossborder/service";
import { gateway } from "@/server/integrations/gateway";
import { sendForConfirmation } from "@/server/confirmations/service";
import { scanInvoice } from "@/server/fraud/engine";
import { putDocument } from "@/server/vault";
import { DataTable, EmptyState, Field, Notice, PageHead, Panel, StatusPill } from "@/components/ui/page";
import { formatINR, formatMinor, rupeesToPaise } from "@/lib/money";

export const metadata = { title: "Export invoices" };
const PATH = "/seller/invoices/export";
const input = "field font-normal";

const Form = z.object({
  buyerId: z.uuid(), invoiceNumber: z.string().min(1).max(40), invoiceDate: z.string(), dueDate: z.string(), currency: z.string().length(3),
  amount: z.string(), shippingBill: z.string().optional(), purposeCode: z.string().optional(), poReference: z.string().optional(),
});

async function upload(fd: FormData) {
  "use server";
  const u = await requireUser(["seller"]);
  let created: { id: string; status: string } | undefined;
  try {
    assertCan(u, "invoice.upload");
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) throw new Error("attach the invoice file");
    if (file.size > 4 * 1024 * 1024) throw new Error("that file is over 4 MB");
    const f = Form.parse(Object.fromEntries(fd));
    const doc = await putDocument(Buffer.from(await file.arrayBuffer()), file.type);
    created = await createExportInvoice(db, {
      sellerId: u.businessId!, buyerId: f.buyerId, invoiceNumber: f.invoiceNumber, invoiceDate: f.invoiceDate, dueDate: f.dueDate, currency: f.currency,
      foreignAmount: rupeesToPaise(f.amount), // two decimals either way: cents here, paise there
      shippingBill: f.shippingBill, purposeCode: f.purposeCode, poReference: f.poReference, contentHash: doc.hash, documentRef: doc.ref,
    });
  } catch (e) {
    redirect(`${PATH}?error=${encodeURIComponent(e instanceof Error ? e.message : "Something went wrong")}`);
  }
  const c = created!;
  after(async () => {
    await scanInvoice(db, c.id).catch((e) => console.error("[fraud-scan]", e.message));
    if (c.status === "validated") await sendForConfirmation(db, c.id).catch((e) => console.error("[confirm]", e.message));
  });
  redirect(`${PATH}?ok=${encodeURIComponent("Export invoice uploaded. Your buyer has been asked to confirm it.")}`);
}

export default async function ExportInvoices({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const u = await requireUser(["seller"]);
  const q = await searchParams;
  const [buyers, mine, rates] = await Promise.all([
    db.select({ id: businesses.id, name: businesses.legalName, country: businesses.country }).from(buyerSellerRelationships)
      .innerJoin(businesses, eq(businesses.id, buyerSellerRelationships.buyerId)).where(eq(buyerSellerRelationships.sellerId, u.businessId!)),
    db.select().from(invoices).where(eq(invoices.sellerId, u.businessId!)).orderBy(desc(invoices.createdAt)),
    Promise.all(CROSS.currencies.map(async (c) => ({ c, ...(await lockRate(gateway, c).catch(() => null)) }))),
  ]);
  const overseas = buyers.filter((b) => b.country);
  const exports = mine.filter((i) => i.currency !== "INR");
  return (
    <>
      <PageHead back={{ href: "/seller/invoices", label: "Invoices" }} title="Export invoices" sub="Finance invoices raised on overseas buyers. We lock the exchange rate when you upload and advance rupees against it." />
      {q.ok && <div className="mb-4"><Notice tone="good">{q.ok}</Notice></div>}
      {q.error && <div className="mb-4"><Notice tone="bad">{q.error}</Notice></div>}
      <div className="mb-5 grid gap-5 xl:grid-cols-[1fr_22rem]">
        {overseas.length === 0 ? (
          <EmptyState icon="globe" title="Add an overseas buyer first">Under Buyers, add the buyer&apos;s country and tax number. They verify their company on Marichi, and then you can raise invoices on them.</EmptyState>
        ) : (
          <Panel title="New export invoice">
            <form action={upload} className="grid gap-4 sm:grid-cols-2">
              <Field label="Overseas buyer" className="sm:col-span-2"><select name="buyerId" required className={input}>{overseas.map((b) => <option key={b.id} value={b.id}>{b.name} ({b.country})</option>)}</select></Field>
              <Field label="Invoice number"><input name="invoiceNumber" required className={input} /></Field>
              <Field label="PO reference"><input name="poReference" className={input} /></Field>
              <Field label="Currency"><select name="currency" className={input}>{CROSS.currencies.map((c) => <option key={c}>{c}</option>)}</select></Field>
              <Field label="Invoice amount (in that currency)"><input name="amount" inputMode="decimal" required placeholder="12,000.00" className={input} /></Field>
              <Field label="Invoice date"><input name="invoiceDate" type="date" required className={input} /></Field>
              <Field label="Due date"><input name="dueDate" type="date" required className={input} /></Field>
              <Field label="Shipping bill number" hint="For goods."><input name="shippingBill" className={input} /></Field>
              <Field label="Purpose code" hint="For services, for example P0802."><input name="purposeCode" className={`${input} uppercase`} /></Field>
              <Field label="Invoice file" className="sm:col-span-2"><input name="file" type="file" required accept="application/pdf,image/*" className={input} /></Field>
              <button className="btn btn-primary sm:col-span-2">Upload export invoice</button>
            </form>
          </Panel>
        )}
        <Panel title="Rates we would lock today" sub={`${CROSS.fxBufferBps / 100}% below the market rate, as a safety margin.`}>
          <ul className="space-y-1.5 text-sm">
            {rates.map((r) => <li key={r.c} className="flex justify-between"><span className="text-muted">1 {r.c}</span><span className="font-medium">{r.lockedMicro ? `₹${(Number(r.lockedMicro) / 1_000_000).toFixed(2)}` : "unavailable"}</span></li>)}
          </ul>
          <p className="mt-3 text-xs text-muted">Export invoices are advanced {CROSS.advanceCutBps / 100} points less than a similar domestic invoice and priced {CROSS.riskPremiumBps / 100} points a year higher. A credit analyst reviews overseas buyers.</p>
        </Panel>
      </div>
      <Panel title="Your export invoices" flush>
        <DataTable rows={exports} rowKey={(i) => i.id} empty="No export invoices yet."
          cols={[
            { h: "No.", cell: (i) => i.invoiceNumber },
            { h: "Invoice", align: "right", cell: (i) => formatMinor(i.foreignAmount ?? 0n, i.currency) },
            { h: "In rupees", align: "right", cell: (i) => <>{formatINR(i.amount)}<span className="block text-xs font-normal text-muted">at ₹{(Number(i.fxRateMicro ?? 0n) / 1_000_000).toFixed(4)}</span></> },
            { h: "Due", cell: (i) => i.dueDate },
            { h: "Status", cell: (i) => <StatusPill status={i.status} /> },
            { h: "Offers", cell: () => <a className="font-semibold text-p-700 underline" href="/seller/invoices">Answer offers</a> },
          ]} />
      </Panel>
    </>
  );
}
