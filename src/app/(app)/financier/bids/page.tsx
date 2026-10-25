import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/server/db/client";
import { bids, invoices } from "@/server/db/schema";
import { requireUser } from "@/server/rbac";
import { assertCan, can } from "@/server/permissions";
import { withdrawBid } from "@/server/marketplace/service";
import { DataTable, Notice, PageHead, Panel, StatusPill } from "@/components/ui/page";
import { formatMoney } from "@/lib/money";
import { attempt } from "../attempt";

export const metadata = { title: "My bids" };
const PATH = "/financier/bids";

async function withdraw(fd: FormData) {
  "use server";
  const u = await requireUser(["financier"]);
  await attempt(PATH, async () => {
    assertCan(u, "bid.place");
    await withdrawBid(db, { id: u.id, role: u.role, businessId: u.businessId }, z.uuid().parse(fd.get("bidId")));
    return "Bid withdrawn.";
  });
}

export default async function Bids({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const u = await requireUser(["financier"]);
  const q = await searchParams;
  const rows = await db.select({ b: bids, inv: invoices.id }).from(bids).innerJoin(invoices, eq(invoices.id, bids.invoiceId))
    .where(eq(bids.financierId, u.businessId!)).orderBy(desc(bids.createdAt)).limit(100);
  const may = can(u, "bid.place");
  return (
    <>
      <PageHead title="My bids" sub="Every bid you have placed and what became of it." />
      {q.ok && <div className="mb-4"><Notice tone="good">{q.ok}</Notice></div>}
      {q.error && <div className="mb-4"><Notice tone="bad">{q.error}</Notice></div>}
      <Panel flush>
        <DataTable rows={rows} rowKey={(r) => r.b.id} empty="You have not placed a bid yet. Open Deal flow to start."
          cols={[
            { h: "Deal", cell: (r) => <span className="font-mono text-xs">{r.inv.slice(0, 8).toUpperCase()}</span> },
            { h: "Advance", align: "right", cell: (r) => formatMoney(r.b.advanceAmount) },
            { h: "Discount", align: "right", cell: (r) => `${r.b.discountBps / 100}% a year` },
            { h: "Tenor", align: "right", cell: (r) => `${r.b.tenorDays} days` },
            { h: "Status", cell: (r) => <StatusPill status={r.b.status === "accepted" ? "approved" : r.b.status === "open" ? "pending" : "rejected"} label={r.b.status} /> },
            { h: "Placed", cell: (r) => <span className="font-normal text-muted">{r.b.createdAt.toLocaleString("en-IN")}</span> },
            { h: "", align: "right", cell: (r) => may && r.b.status === "open" && (
              <form action={withdraw}><input type="hidden" name="bidId" value={r.b.id} /><button className="btn btn-ghost btn-sm">Withdraw</button></form>
            ) },
          ]} />
      </Panel>
    </>
  );
}
