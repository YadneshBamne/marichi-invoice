import { createHmac, timingSafeEqual } from "node:crypto";
import { and, asc, eq, or } from "drizzle-orm";
import type { Database } from "../db/client";
import { agreements, auditLog, businesses, financingOffers, invoices, users } from "../db/schema";
import { gateway, type Adapters } from "../integrations/gateway";
import { ensureVirtualAccount } from "../collections/virtual-accounts";
import { notifyBusiness } from "../notify";
import { putGenerated } from "../vault";
import { renderPdf } from "./pdf";
import { assignmentNotice, invoiceSchedule, masterAgreement } from "./templates";

const STAFF = ["ops", "compliance", "admin"];

/**
 * After an offer is accepted: generate the master agreement (once per seller), the invoice schedule and the
 * assignment notice, ask the e-sign provider for the seller's signature, and send the notice to the buyer.
 * Idempotent and resumable: every step skips what's already done, so the worker can re-run it safely.
 */
export async function prepareAgreements(db: Database, offerId: string, gw: Adapters = gateway, now = new Date()) {
  const [offer] = await db.select().from(financingOffers).where(eq(financingOffers.id, offerId));
  if (!offer) throw new Error("offer not found");
  if (offer.status !== "accepted") throw new Error(`offer is ${offer.status}; agreements are prepared only for accepted offers`);
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, offer.invoiceId));
  const [[seller], [buyer]] = await Promise.all([
    db.select().from(businesses).where(eq(businesses.id, inv.sellerId)),
    db.select().from(businesses).where(eq(businesses.id, inv.buyerId)),
  ]);
  const invoice = { invoiceNumber: inv.invoiceNumber, invoiceDate: inv.invoiceDate, dueDate: inv.dueDate, amount: inv.amount };
  const collection = await ensureVirtualAccount(db, inv.id, gw); // the notice must tell the buyer exactly where to pay

  const docs = [
    { kind: "master", offerId: null, doc: () => masterAgreement({ seller, now }) },
    { kind: "invoice_schedule", offerId, doc: () => invoiceSchedule({ seller, buyer, invoice, offer, now }) },
    { kind: "assignment_notice", offerId, doc: () => assignmentNotice({ seller, buyer, invoice, collection, now }) },
  ] as const;
  for (const d of docs) {
    const exists = await db.select({ id: agreements.id }).from(agreements).where(
      d.kind === "master" ? and(eq(agreements.businessId, seller.id), eq(agreements.kind, "master")) : and(eq(agreements.offerId, offerId), eq(agreements.kind, d.kind)));
    if (exists.length) continue;
    const { ref, hash } = await putGenerated(await renderPdf(d.doc(), { footer: `Marichi Labs  ${d.kind.replaceAll("_", " ")}` }));
    // The partial unique indexes make a concurrent duplicate a no-op rather than a second contract.
    await db.insert(agreements).values({ businessId: seller.id, offerId: d.offerId, kind: d.kind, documentRef: ref, documentHash: hash }).onConflictDoNothing();
  }

  const mine = await db.select().from(agreements).where(and(eq(agreements.businessId, seller.id), or(eq(agreements.kind, "master"), eq(agreements.offerId, offerId))));
  const [signer] = await db.select({ email: users.email }).from(users).where(and(eq(users.businessId, seller.id), eq(users.role, "seller"))).orderBy(asc(users.createdAt)).limit(1);

  for (const a of mine) {
    if (a.status !== "pending") continue;
    if (a.kind === "assignment_notice") {
      const n = await notifyBusiness(db, buyer.id, "assignment_notice", { invoiceNumber: inv.invoiceNumber, link: `/api/documents/${a.documentRef}` }, gw);
      if (n > 0) await db.update(agreements).set({ status: "sent", sentAt: now }).where(eq(agreements.id, a.id));
    } else if (signer) {
      // The agreement id is the idempotency key: a retry after a timeout cannot create a second signing request.
      const r = await gw.esign.request({ idempotencyKey: a.id, documentRef: a.documentRef, signer: signer.email });
      await db.update(agreements).set({ status: "sent", esignRequestId: r.requestId, sentAt: now }).where(eq(agreements.id, a.id));
    }
  }
  await db.insert(auditLog).values({ action: "agreements.prepared", entity: "offer", entityId: offerId });
  return db.select().from(agreements).where(and(eq(agreements.businessId, seller.id), or(eq(agreements.kind, "master"), eq(agreements.offerId, offerId))));
}

/** Worker: (re)prepare agreements for every accepted offer whose invoice hasn't been funded yet. */
export async function prepareAllAccepted(db: Database, gw: Adapters = gateway) {
  const rows = await db.select({ id: financingOffers.id }).from(financingOffers)
    .innerJoin(invoices, eq(invoices.id, financingOffers.invoiceId))
    .where(and(eq(financingOffers.status, "accepted"), eq(invoices.status, "eligible")));
  let n = 0;
  for (const r of rows) {
    try { await prepareAgreements(db, r.id, gw); n++; } catch (e) { console.error("[agreements]", r.id, (e as Error).message); }
  }
  return n;
}

export type Signer = { userId?: string; email?: string; ip?: string; userAgent?: string };

/** Provider callback (or the in-app mock signing). Idempotent: a replayed webhook changes nothing. */
export async function completeSignature(db: Database, p: { requestId: string; outcome: "signed" | "failed"; signer?: Signer }, now = new Date()) {
  return db.transaction(async (tx) => {
    const [a] = await tx.select().from(agreements).where(eq(agreements.esignRequestId, p.requestId)).for("update");
    if (!a) throw new Error("unknown signing request");
    if (a.status === "signed") return { already: true as const, agreement: a };
    if (a.status !== "sent") throw new Error(`agreement is ${a.status}`);
    const [row] = await tx.update(agreements).set(
      p.outcome === "signed"
        ? { status: "signed", signedAt: now, signedBy: p.signer?.userId, signedByEmail: p.signer?.email, signedIp: p.signer?.ip, signedUserAgent: p.signer?.userAgent }
        : { status: "failed" },
    ).where(eq(agreements.id, a.id)).returning();
    await tx.insert(auditLog).values({
      actorId: p.signer?.userId, action: `agreement.${p.outcome}`, entity: "agreement", entityId: a.id, after: { kind: a.kind, hash: a.documentHash },
    });
    return { already: false as const, agreement: row };
  });
}

/** In-app click-to-sign, available only against the mock e-sign provider. Real providers call the webhook instead. */
export async function signInApp(
  db: Database, p: { offerId: string; actor: { id: string; email: string; role: string; businessId: string | null; ip?: string; userAgent?: string } }, now = new Date(),
) {
  if ((process.env.INTEGRATIONS_MODE ?? "mock") !== "mock") throw new Error("in-app signing is only available with the mock e-sign provider");
  const [row] = await db.select({ sellerId: invoices.sellerId }).from(financingOffers)
    .innerJoin(invoices, eq(invoices.id, financingOffers.invoiceId)).where(eq(financingOffers.id, p.offerId));
  if (!row || p.actor.role !== "seller" || p.actor.businessId !== row.sellerId) throw new Error("FORBIDDEN");
  const pending = await db.select().from(agreements).where(and(
    eq(agreements.businessId, row.sellerId), eq(agreements.status, "sent"), or(eq(agreements.kind, "master"), eq(agreements.offerId, p.offerId)),
  ));
  let signed = 0;
  for (const a of pending) {
    if (a.kind === "assignment_notice" || !a.esignRequestId) continue;
    await completeSignature(db, { requestId: a.esignRequestId, outcome: "signed", signer: { userId: p.actor.id, email: p.actor.email, ip: p.actor.ip, userAgent: p.actor.userAgent } }, now);
    signed++;
  }
  return signed;
}

/** HMAC-SHA256 check for provider webhooks (constant-time). */
export function verifyWebhook(rawBody: string, signature: string | null, secret: string) {
  if (!signature || !secret) return false;
  const want = createHmac("sha256", secret).update(rawBody).digest();
  const got = Buffer.from(signature, "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Module 8 gate: master + schedule signed, assignment notice sent. There is deliberately no override here. */
export async function readiness(db: Database, offerId: string) {
  const [row] = await db.select({ sellerId: invoices.sellerId }).from(financingOffers)
    .innerJoin(invoices, eq(invoices.id, financingOffers.invoiceId)).where(eq(financingOffers.id, offerId));
  if (!row) throw new Error("offer not found");
  const rows = await db.select().from(agreements).where(and(eq(agreements.businessId, row.sellerId), or(eq(agreements.kind, "master"), eq(agreements.offerId, offerId))));
  const ok = (kind: string, status: string) => rows.some((a) => a.kind === kind && a.status === status);
  const r = { master: ok("master", "signed"), schedule: ok("invoice_schedule", "signed"), notice: ok("assignment_notice", "sent") };
  return { ...r, ready: r.master && r.schedule && r.notice };
}

export async function assertReadyToDisburse(db: Database, offerId: string) {
  const r = await readiness(db, offerId);
  if (!r.ready) {
    const missing = (Object.keys(r) as (keyof typeof r)[]).filter((k) => k !== "ready" && !r[k]);
    throw new Error(`AGREEMENTS_INCOMPLETE: ${missing.join(", ")}`);
  }
}

/** Who may open a vault document. Buyers see only the assignment notice and invoice files addressed to them (never the pricing). */
export async function canViewDocument(db: Database, user: { role: string; businessId: string | null }, ref: string) {
  const [ag] = await db.select().from(agreements).where(eq(agreements.documentRef, ref));
  const [iv] = await db.select().from(invoices).where(eq(invoices.documentRef, ref));
  if (!ag && !iv) return false;
  if (STAFF.includes(user.role)) return true;
  if (!user.businessId) return false;
  if (user.role === "seller") return ag?.businessId === user.businessId || iv?.sellerId === user.businessId;
  if (user.role === "buyer") {
    if (iv?.buyerId === user.businessId) return true;
    if (ag?.kind === "assignment_notice" && ag.offerId) {
      const [o] = await db.select({ buyerId: invoices.buyerId }).from(financingOffers)
        .innerJoin(invoices, eq(invoices.id, financingOffers.invoiceId)).where(eq(financingOffers.id, ag.offerId));
      return o?.buyerId === user.businessId;
    }
  }
  return false;
}
