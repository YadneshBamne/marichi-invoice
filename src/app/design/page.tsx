import { notFound } from "next/navigation";
import { Card, Empty, PageHead, Pill, Stat } from "@/components/ui/cards";
import { Bars, Donut, HBars, LineChart, Sparkline } from "@/components/ui/charts";
import { AppShell } from "@/components/shell/app-shell";

// Visual QA page for the design system: sample data, no database, dev only.
export const metadata = { title: "Design system" };

export default function Design() {
  if (process.env.NODE_ENV === "production") notFound();
  const days = ["S", "M", "T", "W", "T", "F", "S"].map((label, i) => ({ label, value: [0, 38, 52, 71, 0, 24, 0][i] }));
  const trend = Array.from({ length: 30 }, (_, i) => 6 + Math.sin(i / 3) * 2 + i / 12);
  return (
    <AppShell user={{ name: "Asha Verma", email: "asha@seller.example", role: "seller" }} business={{ name: "Asha Traders Pvt Ltd", kyb: "approved" }} sandbox badges={{}} inbox={[]} tourSeen>
      <PageHead title="Dashboard" sub="Your financing at a glance.">
        <a className="btn btn-primary" href="#">+ Upload invoice</a>
        <a className="btn btn-ghost" href="#">Export CSV</a>
      </PageHead>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat hero label="Available credit" value="₹82.4L" note="of ₹1 Cr limit" href="#" />
        <Stat label="Outstanding" value="₹17.6L" note="across 4 invoices" href="#" />
        <Stat label="Financed to date" value="₹1.4Cr" note="+12% vs last month" tone="good" />
        <Stat label="Overdue" value="1" note="Needs attention" tone="bad" />
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card title="Funding this week" className="lg:col-span-2"><Bars data={days} format={(n) => `₹${n}L`} /></Card>
        <Card title="Book health"><Donut slices={[{ label: "Current", value: 70 }, { label: "1–30 days", value: 18 }, { label: "31–60 days", value: 8 }, { label: "90+", value: 4 }]} center="96%" sub="on time" format={(n) => `${n}%`} /></Card>
        <Card title="Throughput" className="lg:col-span-2"><LineChart labels={trend.map((_, i) => `D${i + 1}`)} series={[{ name: "This period", points: trend }, { name: "Previous", points: trend.map((p) => p * 0.9), dashed: true }]} /></Card>
        <Card title="Pipeline"><HBars rows={[{ label: "Uploaded", value: 48 }, { label: "Confirmed", value: 41, note: "85%" }, { label: "Funded", value: 33, note: "80%" }]} /></Card>
        <Card title="KPI sparkline"><div className="text-3xl font-semibold">91%</div><Sparkline points={trend} /></Card>
        <Card title="Status pills"><div className="flex flex-wrap gap-2"><Pill tone="good">Paid</Pill><Pill tone="warn">Due soon</Pill><Pill tone="bad">Overdue</Pill><Pill tone="info">Under review</Pill><Pill>Draft</Pill></div></Card>
        <Card title="Empty state"><Empty>No invoices yet.</Empty></Card>
      </div>
    </AppShell>
  );
}
