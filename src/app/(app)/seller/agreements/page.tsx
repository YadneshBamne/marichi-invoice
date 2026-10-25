import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { and, eq, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/server/db/client";
import { agreements, financingOffers, invoices } from "@/server/db/schema";
import { requireUser } from "@/server/rbac";
import { assertCan, can } from "@/server/permissions";
import { prepareAgreements, readiness, signAll, signInApp } from "@/server/agreements/service";
import { formatMoney } from "@/lib/money";
import { DataTable, EmptyState, PageHead, ReviewCard, StatusPill } from "@/components/ui/page";

async function sign(fd: FormData) {
  "use server";
  const u = await requireUser(["seller"]);
  assertCan(u, "agreement.sign");
  if (fd.get("agree") !== "on") throw new Error("you must accept the agreement terms");
  const h = await headers();
  await signInApp(db, {
    offerId: z.uuid().parse(fd.get("offerId")),
    actor: { id: u.id, email: u.email, role: u.role, businessId: u.businessId, ip: h.get("x-forwarded-for")?.split(",")[0].trim(), userAgent: h.get("user-agent") ?? undefined },
  });
  revalidatePath("/seller/agreements");
}

async function signEverything(fd: FormData) {
  "use server";
  const u = await requireUser(["seller"]);
  assertCan(u, "agreement.sign");
  if (fd.get("agree") !== "on") throw new Error("you must accept the agreement terms");
  const h = await headers();
  await signAll(db, {
    offerIds: z.array(z.uuid()).min(1).parse(fd.getAll("offerId")),
    actor: { id: u.id, email: u.email, role: u.role, businessId: u.businessId, ip: h.get("x-forwarded-for")?.split(",")[0].trim(), userAgent: h.get("user-agent") ?? undefined },
  });
  revalidatePath("/seller/agreements");
}

const LABEL: Record<string, string> = { master: "Master agreement", invoice_schedule: "Invoice schedule", assignment_notice: "Assignment notice (sent to buyer)", key_facts: "Key facts sheet (what you read before accepting)" };

export default async function Agreements() {
  const u = await requireUser(["seller"]);
  const offers = await db.select({ o: financingOffers, inv: invoices }).from(financingOffers)
    .innerJoin(invoices, eq(invoices.id, financingOffers.invoiceId))
    .where(and(eq(invoices.sellerId, u.businessId!), eq(financingOffers.status, "accepted")));

  const cards = [];
  for (const { o, inv } of offers) {
    await prepareAgreements(db, o.id).catch((e) => console.error("[agreements]", e.message)); // idempotent; self-heals if the worker is behind
    const docs = await db.select().from(agreements).where(and(eq(agreements.businessId, u.businessId!), or(eq(agreements.kind, "master"), eq(agreements.offerId, o.id))));
    cards.push({ o, inv, docs, ready: await readiness(db, o.id) });
  }
  const signer = can(u, "agreement.sign");
  const unsigned = cards.filter((c) => !c.ready.ready);

  return (
    <>
      <PageHead title="Agreements" sub="Each accepted offer needs its documents signed before the funds are released to your bank account." />
      {signer && unsigned.length >= 2 && (
        <form action={signEverything} className="mb-5 flex flex-wrap items-center justify-between gap-4 rounded-card bg-p-100 p-5 ring-1 ring-p-400">
          {unsigned.map((c) => <input key={c.o.id} type="hidden" name="offerId" value={c.o.id} />)}
          <div><p className="font-semibold">{unsigned.length} agreements are waiting for your signature</p><p className="text-muted">Sign them together. Total to be paid out: {formatMoney(unsigned.reduce((a, c) => a + c.o.advanceAmount - c.o.feeAmount, 0n))}.</p></div>
          <div className="flex flex-wrap items-center gap-4"><label className="flex items-center gap-2.5 text-sm"><input name="agree" type="checkbox" required />I have read and agree to all of them.</label><button className="btn btn-primary">Sign all {unsigned.length}</button></div>
        </form>
      )}
      {cards.length === 0 ? <EmptyState icon="file" title="No agreements to sign">Accept an offer on an invoice and its documents will appear here.</EmptyState> : (
        <div className="space-y-5">
          {cards.map(({ o, inv, docs, ready }) => (
            <ReviewCard key={o.id} title={`Invoice ${inv.invoiceNumber}`}
              meta={ready.ready ? <StatusPill status="signed" label="Fully signed" /> : <StatusPill status="pending" label="Waiting for signature" />}
              aside={<><p className="text-xs text-muted">To be paid out</p><p className="text-lg font-semibold">{formatMoney(o.advanceAmount - o.feeAmount)}</p></>}
              actions={ready.ready ? undefined : !signer ? <p className="text-xs text-s-600">Only an approver or the owner can sign. Ask one of them.</p> : (
                <form action={sign} className="flex flex-wrap items-center justify-between gap-3">
                  <input type="hidden" name="offerId" value={o.id} />
                  <label className="flex items-center gap-2.5 text-sm"><input name="agree" type="checkbox" required />I have read and agree to the agreements above.</label>
                  <button className="btn btn-primary btn-sm">Sign</button>
                </form>
              )}>
              <DataTable rows={docs} rowKey={(d) => d.id}
                cols={[
                  { h: "Document", cell: (d) => <a className="text-p-700 hover:underline" href={`/api/documents/${d.documentRef}`} target="_blank">{LABEL[d.kind]}</a> },
                  { h: "Status", cell: (d) => <StatusPill status={d.status === "signed" ? "signed" : "pending"} label={d.status} /> },
                  { h: "Signed", cell: (d) => <span className="font-normal text-muted">{d.signedAt ? d.signedAt.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "-"}</span> },
                ]} />
              {ready.ready ? <p className="mt-4 rounded-lg bg-g-100 px-4 py-3 text-g-600">Fully signed. Funds will be disbursed to your verified bank account.</p> : <p className="mt-3 text-xs text-muted">Demo signing: with a live e-sign provider you would complete this with an Aadhaar OTP instead.</p>}
            </ReviewCard>
          ))}
        </div>
      )}
    </>
  );
}
