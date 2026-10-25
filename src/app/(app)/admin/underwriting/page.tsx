import { revalidatePath } from "next/cache";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/server/db/client";
import { businesses, limitReviews, underwritingDecisions } from "@/server/db/schema";
import { generateOffer } from "@/server/offers/service";
import { requireUser } from "@/server/rbac";
import { pendingReviews, reviewUnderwriting } from "@/server/underwriting/service";
import { DataTable, EmptyState, KV, PageHead, Panel, ReviewCard } from "@/components/ui/page";
import { formatMoney } from "@/lib/money";

export const metadata = { title: "Underwriting" };

const Form = z.object({ decisionId: z.uuid(), outcome: z.enum(["approve", "decline"]), note: z.string().min(1) });

async function decide(fd: FormData) {
  "use server";
  const u = await requireUser(["ops", "admin"]);
  const f = Form.parse(Object.fromEntries(fd));
  await reviewUnderwriting(db, { ...f, reviewerId: u.id, reviewerRole: u.role });
  if (f.outcome === "approve") { // best effort; the worker also generates offers for approved invoices
    const [d] = await db.select({ invoiceId: underwritingDecisions.invoiceId }).from(underwritingDecisions).where(eq(underwritingDecisions.id, f.decisionId));
    await generateOffer(db, d.invoiceId).catch((e) => console.error("[offer]", e.message));
  }
  revalidatePath("/admin/underwriting");
}

const GRADE: Record<string, string> = { A: "bg-g-100 text-g-600", B: "bg-g-100 text-g-600", C: "bg-s-100 text-s-600", D: "bg-r-100 text-r-600", E: "bg-r-100 text-r-600" };

export default async function UnderwritingQueue() {
  await requireUser(["ops", "admin"]);
  const [rows, reviews] = await Promise.all([
    pendingReviews(db),
    db.select({ r: limitReviews, name: businesses.legalName }).from(limitReviews).innerJoin(businesses, eq(businesses.id, limitReviews.businessId)).orderBy(desc(limitReviews.createdAt)).limit(15),
  ]);
  return (
    <>
      <PageHead title="Underwriting" sub="Invoices the policy could not decide on its own. Approve to release an offer, or decline with a reason." />
      {rows.length === 0 ? <EmptyState title="Nothing waiting">Referred invoices will appear here.</EmptyState> : (
        <div className="grid gap-5 xl:grid-cols-2">
          {rows.map(({ d, inv }) => (
            <ReviewCard key={d.id} title={`Invoice ${inv.invoiceNumber}`}
              meta={<><span className={`pill ${GRADE[d.riskGrade] ?? "bg-panel text-muted"}`}>Grade {d.riskGrade}</span><span>PD {(Number(d.pd) * 100).toFixed(1)}%</span></>}
              aside={<p className="text-lg font-semibold">{formatMoney(inv.amount)}</p>}
              actions={
                <form action={decide} className="flex flex-wrap items-center gap-2">
                  <input type="hidden" name="decisionId" value={d.id} />
                  <input name="note" placeholder="Review note (required)" required className="field-inline min-w-52 flex-1 !py-1.5 text-sm" />
                  <button name="outcome" value="approve" className="btn btn-primary btn-sm">Approve</button>
                  <button name="outcome" value="decline" className="btn btn-danger btn-sm">Decline</button>
                </form>
              }>
              <KV rows={[["Proposed advance", `${d.advanceRateBps / 100}%`], ["Proposed discount", `${d.discountRateBps / 100}% p.a.`]]} />
              <p className="mt-3 text-xs font-semibold tracking-wide text-faint uppercase">Why it was referred</p>
              <ul className="mt-1.5 list-disc space-y-1 pl-5 text-muted">{(d.reasons as { code: string; text: string }[]).map((r) => <li key={r.code}>{r.text}</li>)}</ul>
            </ReviewCard>
          ))}
        </div>
      )}
      <Panel title="Recent credit limit reviews" sub="Every seller's limit is reviewed regularly: lowered after late payment, raised after a clean record. Unchanged reviews are listed too." className="mt-5" flush>
        <DataTable rows={reviews} rowKey={(x) => x.r.id} empty="No reviews yet. A seller is first reviewed after a full review period."
          cols={[
            { h: "Seller", cell: (x) => x.name },
            { h: "Before", align: "right", cell: (x) => formatMoney(x.r.before) },
            { h: "After", align: "right", cell: (x) => formatMoney(x.r.after) },
            { h: "Why", cell: (x) => <span className="font-normal text-muted">{x.r.reason}</span> },
            { h: "When", cell: (x) => <span className="font-normal text-muted">{x.r.createdAt.toISOString().slice(0, 10)}</span> },
          ]} />
      </Panel>
    </>
  );
}
