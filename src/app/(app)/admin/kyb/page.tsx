import { revalidatePath } from "next/cache";
import { inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/server/db/client";
import { businesses } from "@/server/db/schema";
import { requireUser } from "@/server/rbac";
import { reviewKyb } from "@/server/kyb/service";
import { EmptyState, KV, PageHead, ReviewCard, StatusPill } from "@/components/ui/page";
import { market } from "@/lib/countries";

export const metadata = { title: "KYB review" };

const Form = z.object({
  businessId: z.uuid(),
  decision: z.enum(["approve", "reject", "request_info"]),
  note: z.string().min(1),
});

async function decide(fd: FormData) {
  "use server";
  const u = await requireUser(["ops", "compliance", "admin"]);
  const f = Form.parse(Object.fromEntries(fd));
  await reviewKyb(db, { ...f, reviewerId: u.id, reviewerRole: u.role });
  revalidatePath("/admin/kyb");
}

export default async function KybQueue() {
  await requireUser(["ops", "compliance", "admin"]);
  const rows = await db.select().from(businesses).where(inArray(businesses.kybStatus, ["under_review", "submitted"]));
  return (
    <>
      <PageHead title="KYB review" sub="Businesses waiting for identity and compliance checks. Sanctions or AML hits are decided here." />
      {rows.length === 0 ? <EmptyState title="Nothing waiting">New verification requests will appear here.</EmptyState> : (
        <div className="grid gap-5 xl:grid-cols-2">
          {rows.map((b) => (
            <ReviewCard key={b.id} title={b.legalName} meta={<><StatusPill status={b.kybStatus} /><span className="capitalize">{b.entityType.replaceAll("_", " ")}</span></>}
              actions={
                <form action={decide} className="flex flex-wrap items-center gap-2">
                  <input type="hidden" name="businessId" value={b.id} />
                  <input name="note" placeholder="Review note (required)" required className="field-inline min-w-52 flex-1 !py-1.5 text-sm" />
                  <button name="decision" value="approve" className="btn btn-primary btn-sm">Approve</button>
                  <button name="decision" value="request_info" className="btn btn-ghost btn-sm">Request info</button>
                  <button name="decision" value="reject" className="btn btn-danger btn-sm">Reject</button>
                </form>
              }>
              <KV rows={[[market().ids.taxReg.label, b.gstin ?? "Not provided"], [market().ids.kyb.label, b.pan ? `${b.pan.slice(0, 2)}${"•".repeat(6)}${b.pan.slice(-2)}` : "Not provided"], ...(market().ids.companyReg ? [[market().ids.companyReg!.label, b.cin ?? "Not provided"] as [string, string]] : []), ["Verification level", b.kybLevel], ...(b.kybNote ? [["System note", b.kybNote] as [string, string]] : [])]} />
            </ReviewCard>
          ))}
        </div>
      )}
    </>
  );
}
