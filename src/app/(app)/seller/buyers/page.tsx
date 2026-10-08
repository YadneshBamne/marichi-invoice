import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/server/db/client";
import { businesses, buyerInvites, buyerSellerRelationships } from "@/server/db/schema";
import { requireUser } from "@/server/rbac";
import { assertCan, can } from "@/server/permissions";
import { linkBuyer } from "@/server/relationships/service";
import { DataTable, Field, Notice, PageHead, Panel, StatusPill } from "@/components/ui/page";

const Form = z.object({
  buyerGstin: z.string().min(15),
  buyerEmail: z.email(),
  creditTermsDays: z.coerce.number().int().min(1).max(365),
});

async function add(fd: FormData) {
  "use server";
  const u = await requireUser(["seller"]);
  assertCan(u, "buyer.invite");
  await linkBuyer(db, { sellerId: u.businessId!, ...Form.parse(Object.fromEntries(fd)) });
  revalidatePath("/seller/buyers");
}

const input = "field font-normal";
export default async function Buyers() {
  const u = await requireUser(["seller"]);
  const [linked, invited] = await Promise.all([
    db.select({ name: businesses.legalName, gstin: businesses.gstin, days: buyerSellerRelationships.creditTermsDays })
      .from(buyerSellerRelationships).innerJoin(businesses, eq(businesses.id, buyerSellerRelationships.buyerId)).where(eq(buyerSellerRelationships.sellerId, u.businessId!)),
    db.select().from(buyerInvites).where(eq(buyerInvites.sellerId, u.businessId!)),
  ]);
  const waiting = invited.filter((i) => i.status === "pending");
  const rows = [
    ...linked.map((b) => ({ key: b.gstin ?? b.name, name: b.name, gstin: b.gstin ?? "", days: b.days as number | null, status: "linked" as const })),
    ...waiting.map((i) => ({ key: i.id, name: i.buyerEmail, gstin: i.buyerGstin, days: null as number | null, status: "invited" as const })),
  ];

  return (
    <>
      <PageHead title="Buyers" sub="The companies that owe you money. A buyer must be linked and verified before their invoices can be financed." />
      <div className="grid gap-5 xl:grid-cols-[1fr_22rem]">
        <Panel title="Linked and invited" sub={`${linked.length} linked, ${waiting.length} waiting`} flush>
          <DataTable rows={rows} rowKey={(r) => r.key} empty="No buyers yet. Add your first one."
            cols={[
              { h: "Buyer", cell: (r) => r.name },
              { h: "GSTIN", cell: (r) => <span className="font-mono text-[13px] font-normal text-muted">{r.gstin}</span> },
              { h: "Credit terms", align: "right", cell: (r) => (r.days ? `${r.days} days` : <span className="text-faint">-</span>) },
              { h: "Status", cell: (r) => (r.status === "linked" ? <StatusPill status="approved" label="Linked" /> : <StatusPill status="pending" label="Invited, not verified yet" />) },
            ]} />
        </Panel>

        {!can(u, "buyer.invite") ? <Notice tone="warn">Your role can view buyers but not link them. Ask a manager or the owner.</Notice> : (
          <Panel title="Add a buyer">
            <form action={add} className="space-y-4">
              <Field label="Buyer GSTIN"><input name="buyerGstin" required className={input} /></Field>
              <Field label="Buyer accounts-payable email"><input name="buyerEmail" type="email" required className={input} /></Field>
              <Field label="Credit terms (days)"><input name="creditTermsDays" type="number" defaultValue={60} className={input} /></Field>
              <button className="btn btn-primary w-full">Add buyer</button>
              <p className="text-xs text-muted">If the buyer is not verified yet, they are invited and linked automatically once they are.</p>
            </form>
          </Panel>
        )}
      </div>
    </>
  );
}
