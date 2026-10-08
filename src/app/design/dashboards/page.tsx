import { notFound } from "next/navigation";
import { AppShell } from "@/components/shell/app-shell";
import { BuyerDashboardView, OpsDashboardView, SellerDashboardView, type BuyerData, type OpsData, type SellerData } from "@/components/dashboards/views";

// Visual QA for the three dashboards with sample data: no database, no auth, dev only.
export const metadata = { title: "Dashboard preview" };
const L = 100_000_00n; // ₹1 lakh in paise
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

const seller: SellerData = {
  kyb: "approved", setup: { verified: true, buyer: true, invoice: true, funded: false }, limit: 100n * L, outstanding: 17n * L + 60_000_00n, available: 82n * L + 40_000_00n, financedToDate: 140n * L, feesPaid: 2n * L + 31_500_00n, overdue: 1,
  funding7d: [0, 38, 52, 71, 0, 24, 0].map((v, i) => ({ date: day(i - 6), amount: BigInt(v) * L })),
  pipeline: { sent_for_confirmation: 2, eligible: 1, financed: 3, overdue: 1, paid: 14 },
  upcoming: [
    { invoiceId: "1", number: "INV-2041", buyer: "Big Corp Ltd", due: day(-3), amount: 6n * L, dpd: 3 },
    { invoiceId: "2", number: "INV-2044", buyer: "Orbit Retail", due: day(9), amount: 4n * L + 50_000_00n, dpd: 0 },
    { invoiceId: "3", number: "INV-2049", buyer: "Big Corp Ltd", due: day(24), amount: 7n * L + 10_000_00n, dpd: 0 },
  ],
  recent: [["INV-2049", 6n], ["INV-2044", 4n], ["INV-2041", 5n], ["INV-2036", 12n], ["INV-2030", 9n]].map(([n, a], i) => ({ number: n as string, amount: (a as bigint) * L, at: new Date(Date.now() - i * 5 * 86_400_000) })),
  attention: { offers: 1, toSign: 2, tickets: 1, disputes: 0 },
};

const buyer: BuyerData = {
  kyb: "approved", pendingCount: 3, pendingValue: 14n * L, due30Value: 22n * L, due30Count: 4, overdueCount: 1, overdueValue: 6n * L,
  suppliers: [
    { seller: "Asha Traders", invoices: 18, volume: 95n * L, terms: 60 }, { seller: "Kiran Components", invoices: 9, volume: 41n * L, terms: 45 }, { seller: "Delta Packaging", invoices: 4, volume: 12n * L, terms: 90 },
  ],
  awaiting: [{ id: "a", number: "INV-3101", seller: "Asha Traders", amount: 6n * L, due: day(40) }, { id: "b", number: "INV-3102", seller: "Kiran Components", amount: 8n * L, due: day(52) }],
  upcoming: [{ id: "c", number: "INV-2990", seller: "Asha Traders", amount: 6n * L, due: day(-2), dpd: 2 }, { id: "d", number: "INV-3011", seller: "Delta Packaging", amount: 4n * L, due: day(11), dpd: 0 }],
};

const ops: OpsData = {
  gtvMonth: 412n * L, gtvPrev: 368n * L, gtvChangePct: 12,
  months: ["May", "Jun", "Jul", "Aug", "Sep", "Oct"].map((label, i) => ({ label, amount: BigInt([120, 190, 240, 300, 368, 412][i]) * L })),
  book: 640n * L, openInvoices: 52, buckets: { "0": 520n * L, "1-30": 70n * L, "31-60": 30n * L, "61-90": 14n * L, "90+": 6n * L }, npaPct: 7.8,
  funnel: { uploaded: 120, confirmed: 104, offered: 96, accepted: 81, funded: 78 }, tatConfirmHours: 9.5, tatPayoutHours: 3.2,
  capital: 500n * L, deployed: 355n * L, utilizationPct: 71, escrow: 88n * L,
  queues: { kyb: 4, underwriting: 6, unmatched: 1, failedPayouts: 0, approvals: 2, ticketsOpen: 11, ticketsBreached: 2 },
  fraud: { open: 3, high: 1 }, recon: { date: day(-1), status: "tied" },
};

export default async function Preview({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  if (process.env.NODE_ENV === "production") notFound();
  const view = (await searchParams).view ?? "seller";
  const role = view === "ops" ? "ops" : view === "buyer" ? "buyer" : "seller";
  return (
    <AppShell user={{ name: "Asha Verma", email: "asha@example.com", role }} business={{ name: "Asha Traders Pvt Ltd", kyb: "approved" }} sandbox badges={{}} inbox={[]} tourSeen>
      {view === "buyer" ? <BuyerDashboardView d={buyer} first="Asha" /> : view === "ops" ? <OpsDashboardView d={ops} /> : <SellerDashboardView d={seller} first="Asha" />}
    </AppShell>
  );
}
