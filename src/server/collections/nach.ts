// NACH auto-debit. A buyer authorises a mandate on their bank account; on the day an invoice falls due we present a debit,
// and a successful debit is booked exactly like a buyer's own transfer (it goes through the collections waterfall).
// Safety rules: one debit in flight per invoice, a hard cap per debit, a notice the day before, three tries then manual.
import { and, count, desc, eq, inArray, isNull, lte } from "drizzle-orm";
import type { Database } from "../db/client";
import { auditLog, collectionEvents, invoiceCollections, invoices, mandates, nachDebits, virtualAccounts } from "../db/schema";
import { gateway, type Adapters } from "../integrations/gateway";
import { notifyBusiness, notifyStaff } from "../notify";
import { daysBetween, isoDay } from "./waterfall";
import { recordIncomingPayment } from "./service";
import { hasOpenDispute } from "../support/disputes";
import { formatINR } from "../../lib/money";
import { maskTail } from "../crypto";

export const NACH = { maxAttempts: 3 };
export type MandateActor = { id: string; role: string; businessId: string | null };
const OPEN = ["pending", "active"];

export async function registerMandate(
  db: Database, actor: MandateActor, p: { accountNumber: string; ifsc: string; holderName: string; maxAmount: bigint }, gw: Adapters = gateway,
) {
  if (actor.role !== "buyer" || !actor.businessId) throw new Error("only a buyer can set up auto-pay");
  const accountNumber = p.accountNumber.replace(/\s/g, ""), ifsc = p.ifsc.trim().toUpperCase();
  if (!/^\d{9,18}$/.test(accountNumber)) throw new Error("enter the bank account number (9 to 18 digits)");
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) throw new Error("enter a valid IFSC code");
  if (p.holderName.trim().length < 2) throw new Error("enter the account holder name");
  if (p.maxAmount <= 0n) throw new Error("set a limit for a single debit");
  const [open] = await db.select({ id: mandates.id }).from(mandates).where(and(eq(mandates.businessId, actor.businessId), inArray(mandates.status, OPEN)));
  if (open) throw new Error("auto-pay is already set up or waiting for your bank; revoke it first to change it");

  const [m] = await db.insert(mandates).values({ businessId: actor.businessId, accountNumber, ifsc, holderName: p.holderName.trim(), maxAmount: p.maxAmount, createdBy: actor.id }).returning();
  const r = await gw.mandates.register({ idempotencyKey: `mandate:${m.id}`, holderName: m.holderName, accountNumber, ifsc, maxAmount: m.maxAmount });
  await db.update(mandates).set({ providerRef: r.mandateRef, status: r.status === "rejected" ? "rejected" : "pending" }).where(eq(mandates.id, m.id));
  await db.insert(auditLog).values({ actorId: actor.id, action: "mandate.registered", entity: "business", entityId: actor.businessId, after: { mandateId: m.id, account: maskTail(accountNumber), maxAmount: m.maxAmount.toString() } });
  if (r.status === "active") await applyMandateStatus(db, r.mandateRef, "active", undefined, gw);
  if (r.status === "rejected") await applyMandateStatus(db, r.mandateRef, "rejected", r.reason, gw);
  return (await db.select().from(mandates).where(eq(mandates.id, m.id)))[0];
}

/** The bank's answer (webhook, or the simulated authorisation in mock mode). Idempotent. */
export async function applyMandateStatus(db: Database, providerRef: string, status: "active" | "rejected", reason?: string, gw: Adapters = gateway, now = new Date()) {
  const [m] = await db.select().from(mandates).where(eq(mandates.providerRef, providerRef));
  if (!m) throw new Error("unknown mandate");
  if (m.status !== "pending") return m; // already decided: a replayed webhook changes nothing
  const [u] = await db.update(mandates).set({ status, ...(status === "active" ? { activatedAt: now } : {}) }).where(and(eq(mandates.id, m.id), eq(mandates.status, "pending"))).returning();
  if (!u) return m;
  await db.insert(auditLog).values({ action: `mandate.${status}`, entity: "business", entityId: m.businessId, after: { mandateId: m.id } });
  if (status === "active") await notifyBusiness(db, m.businessId, "mandate_active", { account: maskTail(m.accountNumber) }, gw, now);
  else await notifyBusiness(db, m.businessId, "mandate_rejected", { reason: reason ?? "no reason given" }, gw, now);
  return u;
}

export async function revokeMandate(db: Database, actor: MandateActor, mandateId: string, gw: Adapters = gateway, now = new Date()) {
  const [m] = await db.select().from(mandates).where(eq(mandates.id, mandateId));
  if (!m || m.businessId !== actor.businessId || actor.role !== "buyer") throw new Error("FORBIDDEN");
  if (!OPEN.includes(m.status)) throw new Error(`auto-pay is already ${m.status}`);
  await db.update(mandates).set({ status: "revoked", revokedAt: now }).where(eq(mandates.id, m.id));
  if (m.providerRef) await gw.mandates.cancel(m.providerRef).catch((e) => console.error("[mandate] cancel", e.message)); // we have stopped using it either way
  await db.insert(auditLog).values({ actorId: actor.id, action: "mandate.revoked", entity: "business", entityId: m.businessId, after: { mandateId } });
}

/** Book the bank's answer to a debit. Idempotent on the key. A success is a normal repayment. */
export async function applyDebitResult(
  db: Database, r: { idempotencyKey: string; status: "succeeded" | "failed"; providerRef?: string; utr?: string; reason?: string }, gw: Adapters = gateway, now = new Date(),
) {
  const [d] = await db.select().from(nachDebits).where(eq(nachDebits.idempotencyKey, r.idempotencyKey));
  if (!d) throw new Error("unknown debit");
  if (d.status !== "processing") return { status: "replayed" as const };
  const [claimed] = await db.update(nachDebits).set({ status: r.status, providerRef: r.providerRef ?? d.providerRef, failureReason: r.status === "failed" ? r.reason ?? "debit failed" : null, settledAt: now })
    .where(and(eq(nachDebits.id, d.id), eq(nachDebits.status, "processing"))).returning();
  if (!claimed) return { status: "replayed" as const };
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, d.invoiceId));

  if (r.status === "succeeded") {
    const [va] = await db.select().from(virtualAccounts).where(eq(virtualAccounts.invoiceId, d.invoiceId));
    const credit = await recordIncomingPayment(db, { accountNumber: va.accountNumber, amount: d.amount, utr: r.utr ?? r.providerRef ?? d.idempotencyKey, receivedAt: now }, gw, now);
    return { status: "succeeded" as const, credit };
  }
  await db.insert(auditLog).values({ action: "nach.debit_failed", entity: "invoice", entityId: d.invoiceId, after: { attempt: d.attempt, reason: r.reason ?? null } });
  await notifyBusiness(db, inv.buyerId, "nach_debit_failed", { invoiceNumber: inv.invoiceNumber, amount: formatINR(d.amount), reason: r.reason ?? "debit failed" }, gw, now);
  await notifyStaff(db, ["ops"], "collections_escalation", { invoiceNumber: inv.invoiceNumber, due: inv.dueDate, amount: formatINR(d.amount), dpd: "0" }, gw, now);
  return { status: "failed" as const };
}

/** Worker, daily: present a debit for every due invoice whose buyer has an active mandate. */
export async function presentDebits(db: Database, gw: Adapters = gateway, now = new Date()) {
  const today = isoDay(now);
  const due = await db.select({ inv: invoices, m: mandates }).from(invoiceCollections)
    .innerJoin(invoices, eq(invoices.id, invoiceCollections.invoiceId))
    .innerJoin(mandates, and(eq(mandates.businessId, invoices.buyerId), eq(mandates.status, "active")))
    .where(and(isNull(invoiceCollections.closedAt), inArray(invoices.status, ["financed", "due", "overdue"]), lte(invoices.dueDate, today)));

  const out = { presented: 0, skipped: 0 };
  for (const { inv, m } of due) {
    if (await hasOpenDispute(db, inv.id)) { out.skipped++; continue; }
    const prior = await db.select().from(nachDebits).where(eq(nachDebits.invoiceId, inv.id)).orderBy(desc(nachDebits.attempt));
    const last = prior[0];
    if (last && (last.status !== "failed" || isoDay(last.presentedAt) === today)) { out.skipped++; continue; } // one in flight, paid, or already tried today
    if (prior.length >= NACH.maxAttempts) { out.skipped++; continue; } // out of tries: the normal overdue and recourse flow takes over
    if (inv.amount > m.maxAmount) {
      const first = await db.insert(collectionEvents).values({ invoiceId: inv.id, kind: "nach_over_limit" }).onConflictDoNothing().returning({ id: collectionEvents.id });
      if (first.length) await notifyBusiness(db, inv.buyerId, "nach_over_limit", { invoiceNumber: inv.invoiceNumber, amount: formatINR(inv.amount), limit: formatINR(m.maxAmount) }, gw, now);
      out.skipped++; continue;
    }
    const attempt = prior.length + 1;
    const key = `nach:${inv.id}:${attempt}`;
    const [row] = await db.insert(nachDebits).values({ invoiceId: inv.id, mandateId: m.id, amount: inv.amount, attempt, idempotencyKey: key, presentedAt: now }).onConflictDoNothing().returning();
    if (!row) { out.skipped++; continue; } // another worker got there first
    try {
      const res = await gw.mandates.debit({ idempotencyKey: key, mandateRef: m.providerRef!, amount: inv.amount, reference: `Invoice ${inv.invoiceNumber}` });
      await db.update(nachDebits).set({ providerRef: res.debitRef }).where(eq(nachDebits.id, row.id));
      if (res.status !== "processing") await applyDebitResult(db, { idempotencyKey: key, status: res.status, providerRef: res.debitRef, utr: res.utr, reason: res.reason }, gw, now);
    } catch (e) {
      // The bank could not be reached. The row stays `processing` so nothing is presented twice; the webhook or a manual check resolves it.
      console.error("[nach] debit call failed", inv.invoiceNumber, (e as Error).message);
    }
    out.presented++;
  }
  return out;
}

/** Worker, daily: tell buyers a debit will happen tomorrow (the day-before notice that bank rules require). */
export async function sendPreDebitNotices(db: Database, gw: Adapters = gateway, now = new Date()) {
  const tomorrow = isoDay(new Date(now.getTime() + 86_400_000));
  const rows = await db.select({ inv: invoices }).from(invoiceCollections)
    .innerJoin(invoices, eq(invoices.id, invoiceCollections.invoiceId))
    .innerJoin(mandates, and(eq(mandates.businessId, invoices.buyerId), eq(mandates.status, "active")))
    .where(and(isNull(invoiceCollections.closedAt), eq(invoices.dueDate, tomorrow), inArray(invoices.status, ["financed", "due"])));
  let n = 0;
  for (const { inv } of rows) {
    const first = await db.insert(collectionEvents).values({ invoiceId: inv.id, kind: "nach_notice" }).onConflictDoNothing().returning({ id: collectionEvents.id });
    if (!first.length) continue;
    await notifyBusiness(db, inv.buyerId, "nach_pre_debit", { invoiceNumber: inv.invoiceNumber, amount: formatINR(inv.amount), due: inv.dueDate }, gw, now);
    n++;
  }
  return n;
}

export const myMandate = async (db: Database, businessId: string) =>
  (await db.select().from(mandates).where(eq(mandates.businessId, businessId)).orderBy(desc(mandates.createdAt)).limit(1))[0] ?? null;

export const recentDebits = (db: Database, limit = 50) =>
  db.select({ d: nachDebits, inv: invoices }).from(nachDebits).innerJoin(invoices, eq(invoices.id, nachDebits.invoiceId)).orderBy(desc(nachDebits.presentedAt)).limit(limit);

export const countOpenDebits = async (db: Database) => (await db.select({ n: count() }).from(nachDebits).where(eq(nachDebits.status, "processing")))[0].n;
