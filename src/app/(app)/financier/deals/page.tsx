import { z } from "zod";
import { db } from "@/server/db/client";
import { requireUser } from "@/server/rbac";
import { assertCan, can } from "@/server/permissions";
import { dealFlow, MARKET, position } from "@/server/marketplace/service";
import { submit } from "@/server/approvals/service";
import { profileOf } from "@/server/marketplace/financier";
import { invoices } from "@/server/db/schema";
import { eq } from "drizzle-orm";
import { priceOffer } from "@/server/offers/pricing";
import { DataTable, EmptyState, Notice, PageHead, Panel, Pop } from "@/components/ui/page";
import { Stat } from "@/components/ui/cards";
import { formatMoney } from "@/lib/money";
import { attempt } from "../attempt";

export const metadata = { title: "Deal flow" };
const PATH = "/financier/deals";

const Bid = z.object({ invoiceId: z.uuid(), advancePct: z.coerce.number().min(1).max(100), discountPct: z.coerce.number().min(0).max(100), sharePct: z.coerce.number().min(5).max(100).default(100) });

async function bid(fd: FormData) {
  "use server";
  const u = await requireUser(["financier"]);
  await attempt(PATH, async () => {
    assertCan(u, "bid.prepare");
    const f = Bid.parse(Object.fromEntries(fd));
    const advanceBps = Math.round(f.advancePct * 100), discountBps = Math.round(f.discountPct * 100);
    const [inv] = await db.select({ amount: invoices.amount }).from(invoices).where(eq(invoices.id, f.invoiceId));
    if (!inv) throw new Error("this invoice is not open for bids");
    const shareBps = Math.round(f.sharePct * 100);
    const advance = (((inv.amount * BigInt(advanceBps)) / 10_000n) * BigInt(shareBps)) / 10_000n;
    const r = await submit(db, { id: u.id, role: u.role, orgRole: u.orgRole, businessId: u.businessId }, "bid.place", { invoiceId: f.invoiceId, advanceBps, discountBps, shareBps },
      { summary: `Bid ${formatMoney(advance)}${shareBps < 10_000 ? ` (${shareBps / 100}% of the advance)` : ""} at ${discountBps / 100}% a year on deal ${f.invoiceId.slice(0, 8).toUpperCase()}`, amount: advance });
    if (r.status === "queued") return "Sent for approval. An approver in your company will see it under Approvals. Nothing is bid until they approve.";
    const b = r.result as { advanceAmount: bigint; discountBps: number; expiresAt: Date };
    return `Bid placed: ${formatMoney(b.advanceAmount)} at ${b.discountBps / 100}% a year. It stays open until ${b.expiresAt.toLocaleString("en-IN")}.`;
  });
}

const BundleBid = z.object({ bundleId: z.uuid(), advancePct: z.coerce.number().min(1).max(100), discountPct: z.coerce.number().min(0).max(100) });

async function bidBundle(fd: FormData) {
  "use server";
  const u = await requireUser(["financier"]);
  await attempt(PATH, async () => {
    assertCan(u, "bid.prepare");
    const f = BundleBid.parse(Object.fromEntries(fd));
    const advanceBps = Math.round(f.advancePct * 100), discountBps = Math.round(f.discountPct * 100);
    const members = await db.select({ amount: invoices.amount }).from(invoices).where(eq(invoices.bundleId, f.bundleId));
    if (!members.length) throw new Error("this bundle is no longer open for bids");
    const advance = members.reduce((a, m) => a + (m.amount * BigInt(advanceBps)) / 10_000n, 0n);
    const r = await submit(db, { id: u.id, role: u.role, orgRole: u.orgRole, businessId: u.businessId }, "bundle.bid", { bundleId: f.bundleId, advanceBps, discountBps },
      { summary: `Bid ${formatMoney(advance)} at ${discountBps / 100}% a year on a bundle of ${members.length} invoices`, amount: advance });
    if (r.status === "queued") return "Sent for approval. An approver in your company will see it under Approvals. Nothing is bid until they approve.";
    return `Bid placed on all ${members.length} invoices of the bundle: ${formatMoney(advance)} at ${discountBps / 100}% a year.`;
  });
}

export default async function Deals({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const u = await requireUser(["financier"]);
  const q = await searchParams;
  const [deals, pos, prof] = await Promise.all([dealFlow(db, u.businessId!), position(db, u.businessId!), profileOf(db, u.businessId!)]);
  const may = can(u, "bid.prepare");
  const bundleDeals = [...Map.groupBy(deals.filter((d) => d.bundleId), (d) => d.bundleId!).entries()].map(([id, list]) => ({ id, list })).filter((b) => b.list.length >= 2);
  const direct = can(u, "bid.place"); // approver or owner commit on their own; a maker sends it for approval
  return (
    <>
      <PageHead title="Deal flow" sub="Approved, buyer-confirmed invoices waiting for funding. The seller is not named until a bid is accepted." />
      {q.ok && <div className="mb-4"><Notice tone="good">{q.ok}</Notice></div>}
      {q.error && <div className="mb-4"><Notice tone="bad">{q.error}</Notice></div>}
      <div className="mb-5 grid gap-4 sm:grid-cols-3">
        <Stat hero label="Available to bid" value={formatMoney(pos.available)} note="your funds less accepted deals" />
        <Stat label="Deployed" value={formatMoney(pos.deployed)} note="out in financed invoices" />
        <Stat label="Open deals" value={String(deals.length)} note="waiting for a bid" />
      </div>
      {!may && <div className="mb-4"><Notice tone="warn">Your role can view deal flow but not bid.</Notice></div>}
      {prof?.status !== "approved" && <div className="mb-4"><Notice tone="warn">You can look at deals, but you can bid once your licence is approved. <a className="font-semibold underline" href="/financier/application">Go to your application</a>.</Notice></div>}
      {bundleDeals.length > 0 && (
        <Panel title={`${bundleDeals.length} bundle${bundleDeals.length === 1 ? "" : "s"}`} sub="Several invoices on one buyer, funded together. One bid covers every invoice at the same terms; you are bid for all of them or none." className="mb-5" flush>
          <DataTable rows={bundleDeals} rowKey={(b) => b.id}
            cols={[
              { h: "Buyer", cell: (b) => <>{b.list[0].buyer}<span className="block text-xs font-normal text-muted">grade {[...new Set(b.list.map((d) => d.grade))].join(", ")}</span></> },
              { h: "Invoices", align: "right", cell: (b) => b.list.length },
              { h: "Total", align: "right", cell: (b) => formatMoney(b.list.reduce((a, d) => a + d.amount, 0n)) },
              { h: "Due", cell: (b) => <>{b.list[0].dueDate}{b.list.at(-1)!.dueDate !== b.list[0].dueDate && <span className="block text-xs font-normal text-muted">to {b.list.at(-1)!.dueDate}</span>}</> },
              { h: "Max advance", align: "right", cell: (b) => `${Math.min(...b.list.map((d) => d.maxAdvanceBps)) / 100}%` },
              { h: "Your bid", cell: (b) => b.list.every((d) => d.myBid) ? <span className="text-p-700">all {b.list.length} bid</span> : <span className="text-faint">none</span> },
              { h: "", align: "right", cell: (b) => {
                const maxAdv = Math.min(...b.list.map((d) => d.maxAdvanceBps));
                const guide = Number(b.list.reduce((a, d) => a + BigInt(d.guideDiscountBps) * d.amount, 0n) / b.list.reduce((a, d) => a + d.amount, 0n));
                return may && (
                  <Pop id={`bundle-${b.id}`} label={b.list.every((d) => d.myBid) ? "Change bid" : "Bid on bundle"} cls="btn btn-primary btn-sm">
                    <form action={bidBundle} className="space-y-2">
                      <input type="hidden" name="bundleId" value={b.id} />
                      <label className="block text-xs font-medium">Advance (% of each invoice, up to {maxAdv / 100})
                        <input name="advancePct" type="number" step="0.01" min="1" max={maxAdv / 100} defaultValue={maxAdv / 100} required className="field !py-2 text-sm font-normal" /></label>
                      <label className="block text-xs font-medium">Discount (% a year, {MARKET.minDiscountBps / 100} to {MARKET.maxDiscountBps / 100})
                        <input name="discountPct" type="number" step="0.01" min={MARKET.minDiscountBps / 100} max={MARKET.maxDiscountBps / 100} defaultValue={guide / 100} required className="field !py-2 text-sm font-normal" /></label>
                      <p className="text-xs text-muted">Needs funds for the whole bundle. Your buyer limit must cover all of it.</p>
                      <button className="btn btn-primary btn-sm w-full">{direct ? "Place bid" : "Submit for approval"}</button>
                    </form>
                  </Pop>
                );
              } },
            ]} />
        </Panel>
      )}
      {deals.length === 0 ? <EmptyState icon="layers" title="No deals right now">New approved invoices appear here as sellers upload them.</EmptyState> : (
        <Panel title={`${deals.length} open`} flush>
          <DataTable rows={deals} rowKey={(d) => d.invoiceId}
            cols={[
              { h: "Deal", cell: (d) => <><span className="font-mono text-xs">{d.ref}</span>{d.bundleId && <span className="pill ml-2 bg-i-100 text-i-500">In a bundle</span>}</> },
              { h: "Grade", cell: (d) => d.grade },
              { h: "Buyer", cell: (d) => d.buyer },
              { h: "Invoice", align: "right", cell: (d) => formatMoney(d.amount) },
              { h: "Due", cell: (d) => <>{d.dueDate}<span className="block text-xs font-normal text-muted">{d.tenorDays} days</span></> },
              { h: "Max advance", align: "right", cell: (d) => <>{d.maxAdvanceBps / 100}%<span className="block text-xs font-normal text-muted">{formatMoney((d.amount * BigInt(d.maxAdvanceBps)) / 10_000n)}</span></> },
              { h: "Your bid", cell: (d) => d.myBid
                ? <span className="text-p-700">{formatMoney(d.myBid.advanceAmount)} at {d.myBid.discountBps / 100}%</span>
                : <span className="text-faint">none</span> },
              { h: "", align: "right", cell: (d) => may && !d.bundleId && (
                <Pop id={`bid-${d.invoiceId}`} label={d.myBid ? "Change bid" : "Bid"} cls="btn btn-primary btn-sm">
                  <form action={bid} className="space-y-2">
                    <input type="hidden" name="invoiceId" value={d.invoiceId} />
                    <label className="block text-xs font-medium">Advance (% of invoice, up to {d.maxAdvanceBps / 100})
                      <input name="advancePct" type="number" step="0.01" min="1" max={d.maxAdvanceBps / 100} defaultValue={d.maxAdvanceBps / 100} required className="field !py-2 text-sm font-normal" /></label>
                    <label className="block text-xs font-medium">Discount (% a year, {MARKET.minDiscountBps / 100} to {MARKET.maxDiscountBps / 100})
                      <input name="discountPct" type="number" step="0.01" min={MARKET.minDiscountBps / 100} max={MARKET.maxDiscountBps / 100} defaultValue={d.guideDiscountBps / 100} required className="field !py-2 text-sm font-normal" /></label>
                    <label className="block text-xs font-medium">Share of the advance you will fund (%, 100 funds all of it; a smaller share is combined with other financiers)
                      <input name="sharePct" type="number" step="1" min="5" max="100" defaultValue={100} required className="field !py-2 text-sm font-normal" /></label>
                    <p className="text-xs text-muted">Guide for this grade: {d.guideDiscountBps / 100}% a year. At the guide your return over {d.tenorDays} days is about {formatMoney(priceOffer({ amount: d.amount, advanceBps: d.maxAdvanceBps, discountBps: d.guideDiscountBps, tenorDays: d.tenorDays }).expectedDiscount * BigInt(10_000 - MARKET.platformShareBps) / 10_000n)} after the platform share.</p>
                    <button className="btn btn-primary btn-sm w-full">{direct ? "Place bid" : "Submit for approval"}</button>
                  </form>
                </Pop>
              ) },
            ]} />
        </Panel>
      )}
    </>
  );
}
