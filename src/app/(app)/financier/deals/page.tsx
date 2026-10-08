import { z } from "zod";
import { db } from "@/server/db/client";
import { requireUser } from "@/server/rbac";
import { assertCan, can } from "@/server/permissions";
import { dealFlow, MARKET, placeBid, position } from "@/server/marketplace/service";
import { priceOffer } from "@/server/offers/pricing";
import { DataTable, EmptyState, Notice, PageHead, Panel } from "@/components/ui/page";
import { Stat } from "@/components/ui/cards";
import { formatINR } from "@/lib/money";
import { attempt } from "../attempt";

export const metadata = { title: "Deal flow" };
const PATH = "/financier/deals";

const Bid = z.object({ invoiceId: z.uuid(), advancePct: z.coerce.number().min(1).max(100), discountPct: z.coerce.number().min(0).max(100) });

async function bid(fd: FormData) {
  "use server";
  const u = await requireUser(["financier"]);
  await attempt(PATH, async () => {
    assertCan(u, "bid.place");
    const f = Bid.parse(Object.fromEntries(fd));
    const b = await placeBid(db, { id: u.id, role: u.role, businessId: u.businessId }, { invoiceId: f.invoiceId, advanceBps: Math.round(f.advancePct * 100), discountBps: Math.round(f.discountPct * 100) });
    return `Bid placed: ${formatINR(b.advanceAmount)} at ${b.discountBps / 100}% a year. It stays open until ${b.expiresAt.toLocaleString("en-IN")}.`;
  });
}

export default async function Deals({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const u = await requireUser(["financier"]);
  const q = await searchParams;
  const [deals, pos] = await Promise.all([dealFlow(db, u.businessId!), position(db, u.businessId!)]);
  const may = can(u, "bid.place");
  return (
    <>
      <PageHead title="Deal flow" sub="Approved, buyer-confirmed invoices waiting for funding. The seller is not named until a bid is accepted." />
      {q.ok && <div className="mb-4"><Notice tone="good">{q.ok}</Notice></div>}
      {q.error && <div className="mb-4"><Notice tone="bad">{q.error}</Notice></div>}
      <div className="mb-5 grid gap-4 sm:grid-cols-3">
        <Stat hero label="Available to bid" value={formatINR(pos.available)} note="your funds less accepted deals" />
        <Stat label="Deployed" value={formatINR(pos.deployed)} note="out in financed invoices" />
        <Stat label="Open deals" value={String(deals.length)} note="waiting for a bid" />
      </div>
      {!may && <div className="mb-4"><Notice tone="warn">Placing a bid commits the company. Ask a manager or the owner to bid.</Notice></div>}
      {deals.length === 0 ? <EmptyState icon="layers" title="No deals right now">New approved invoices appear here as sellers upload them.</EmptyState> : (
        <Panel title={`${deals.length} open`} flush>
          <DataTable rows={deals} rowKey={(d) => d.invoiceId}
            cols={[
              { h: "Deal", cell: (d) => <span className="font-mono text-xs">{d.ref}</span> },
              { h: "Grade", cell: (d) => d.grade },
              { h: "Buyer", cell: (d) => d.buyer },
              { h: "Invoice", align: "right", cell: (d) => formatINR(d.amount) },
              { h: "Due", cell: (d) => <>{d.dueDate}<span className="block text-xs font-normal text-muted">{d.tenorDays} days</span></> },
              { h: "Max advance", align: "right", cell: (d) => <>{d.maxAdvanceBps / 100}%<span className="block text-xs font-normal text-muted">{formatINR((d.amount * BigInt(d.maxAdvanceBps)) / 10_000n)}</span></> },
              { h: "Your bid", cell: (d) => d.myBid
                ? <span className="text-p-700">{formatINR(d.myBid.advanceAmount)} at {d.myBid.discountBps / 100}%</span>
                : <span className="text-faint">none</span> },
              { h: "", align: "right", cell: (d) => may && (
                <details className="relative inline-block text-left">
                  <summary className="btn btn-primary btn-sm cursor-pointer list-none">{d.myBid ? "Change bid" : "Bid"}</summary>
                  <form action={bid} className="absolute right-0 z-10 mt-2 w-72 space-y-2 rounded-card bg-card p-4 shadow-pop">
                    <input type="hidden" name="invoiceId" value={d.invoiceId} />
                    <label className="block text-xs font-medium">Advance (% of invoice, up to {d.maxAdvanceBps / 100})
                      <input name="advancePct" type="number" step="0.01" min="1" max={d.maxAdvanceBps / 100} defaultValue={d.maxAdvanceBps / 100} required className="field !py-2 text-sm font-normal" /></label>
                    <label className="block text-xs font-medium">Discount (% a year, {MARKET.minDiscountBps / 100} to {MARKET.maxDiscountBps / 100})
                      <input name="discountPct" type="number" step="0.01" min={MARKET.minDiscountBps / 100} max={MARKET.maxDiscountBps / 100} defaultValue={d.guideDiscountBps / 100} required className="field !py-2 text-sm font-normal" /></label>
                    <p className="text-xs text-muted">Guide for this grade: {d.guideDiscountBps / 100}% a year. At the guide your return over {d.tenorDays} days is about {formatINR(priceOffer({ amount: d.amount, advanceBps: d.maxAdvanceBps, discountBps: d.guideDiscountBps, tenorDays: d.tenorDays }).expectedDiscount * BigInt(10_000 - MARKET.platformShareBps) / 10_000n)} after the platform share.</p>
                    <button className="btn btn-primary btn-sm w-full">Place bid</button>
                  </form>
                </details>
              ) },
            ]} />
        </Panel>
      )}
    </>
  );
}
