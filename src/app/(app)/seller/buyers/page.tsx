import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/server/db/client";
import { businesses, buyerInvites, buyerSellerRelationships } from "@/server/db/schema";
import { requireUser } from "@/server/rbac";
import { assertCan, can } from "@/server/permissions";
import { linkBuyer } from "@/server/relationships/service";
import { invitationsFor, respondInvite } from "@/server/scf/service";
import { formatINR } from "@/lib/money";
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

async function answerInvite(fd: FormData) {
  "use server";
  const u = await requireUser(["seller"]);
  assertCan(u, "programme.join");
  await respondInvite(db, { id: u.id, role: u.role, businessId: u.businessId }, z.uuid().parse(fd.get("programmeId")), fd.get("action") === "accept");
  revalidatePath("/seller/buyers");
}

const input = "field font-normal";
export default async function Buyers() {
  const u = await requireUser(["seller"]);
  const [programmes, linked, invited] = await Promise.all([
    invitationsFor(db, u.businessId!),
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
      {programmes.length > 0 && (
        <Panel title="Supplier finance programmes" sub="A buyer that runs a programme finances your invoices on its credit, usually at a lower rate than your own." className="mb-5" flush>
          <DataTable rows={programmes} rowKey={(p) => p.s.id}
            cols={[
              { h: "Buyer", cell: (p) => <>{p.buyer}<span className="block text-xs font-normal text-muted">{p.p.name}</span></> },
              { h: "Price", align: "right", cell: (p) => `${(p.p.discountBps ?? 0) / 100}% a year` },
              { h: "Advance", align: "right", cell: (p) => `${(p.p.advanceBps ?? 0) / 100}%` },
              { h: "Programme limit", align: "right", cell: (p) => formatINR(p.p.limit) },
              { h: "Status", cell: (p) => <StatusPill status={p.s.status === "active" ? "approved" : "pending"} label={p.s.status === "active" ? "Joined" : "Invited"} /> },
              { h: "", align: "right", cell: (p) => p.s.status === "invited" && can(u, "programme.join") && (
                <form action={answerInvite} className="inline-flex gap-2"><input type="hidden" name="programmeId" value={p.p.id} /><button name="action" value="accept" className="btn btn-primary btn-sm">Join</button><button name="action" value="decline" className="btn btn-ghost btn-sm">Decline</button></form>
              ) },
            ]} />
        </Panel>
      )}
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
