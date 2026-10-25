// The formal step after reminders: a written demand with a date to pay by, then, if that date passes, handing the invoice to a recovery
// agency or lawyer. The notice text is a draft for counsel (agreements/templates.ts, legalNotice). Everything here is a staff decision:
// nothing is sent or handed over by a timer. The sweep only closes notices on invoices that were paid and tells staff when to act.
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { auditLog, businesses, collectionEvents, financingOffers, invoiceCollections, invoiceDisputes, invoices, legalNotices, virtualAccounts } from "../db/schema";
import { gateway, type Adapters } from "../integrations/gateway";
import { notifyBusiness, notifyStaff } from "../notify";
import { putGenerated } from "../vault";
import { renderPdf } from "../agreements/pdf";
import { legalNotice } from "../agreements/templates";
import { termsFor } from "../agreements/country";
import { financierFor } from "../agreements/keyfacts";
import { formatMoney } from "../../lib/money";
import { accrue, COLLECTIONS, daysBetween, isoDay } from "./waterfall";

export type Addressee = "buyer" | "seller";
export type Staff = { id: string; role: string };
const ALLOWED = ["admin", "compliance"];
const DAY = 86_400_000;
const noticeNo = (seq: number) => `LN-${String(seq).padStart(5, "0")}`;
const addDays = (day: string, n: number) => isoDay(new Date(Date.parse(day) + n * DAY));

/** What a notice about this invoice would say today, or the plain reason it cannot be issued. */
export async function noticeCheck(db: Database, invoiceId: string, addressee: Addressee, now: Date) {
  const [row] = await db.select({ i: invoices, c: invoiceCollections }).from(invoices).leftJoin(invoiceCollections, eq(invoiceCollections.invoiceId, invoices.id)).where(eq(invoices.id, invoiceId));
  if (!row) throw new Error("invoice not found");
  const { i, c } = row;
  if (!c || c.closedAt) throw new Error("nothing is outstanding on this invoice");
  const [offer] = await db.select().from(financingOffers).where(and(eq(financingOffers.invoiceId, invoiceId), eq(financingOffers.status, "accepted")));
  if (!offer) throw new Error("this invoice was not financed");
  if (addressee === "seller" && !offer.recourse) throw new Error("this financing is without recourse, so the seller cannot be asked to repay");
  const today = isoDay(now), dpd = daysBetween(i.dueDate, today);
  if (dpd < COLLECTIONS.legalNoticeAfterDpd) throw new Error(`a legal notice can be issued from ${COLLECTIONS.legalNoticeAfterDpd} days past due; this invoice is ${Math.max(0, dpd)}`);
  const [dispute] = await db.select({ id: invoiceDisputes.id }).from(invoiceDisputes).where(and(eq(invoiceDisputes.invoiceId, invoiceId), eq(invoiceDisputes.status, "open")));
  if (dispute) throw new Error("this invoice is in dispute; settle the dispute first");
  const due = accrue({ principal: c.principal, discount: c.discount, penal: c.penal, lastAccrued: c.lastAccruedOn }, today, { discountBps: c.discountBps, penalBps: c.penalBps, dueDate: i.dueDate });
  return { invoice: i, offer, dpd, due };
}

export async function issueLegalNotice(db: Database, staff: Staff, p: { invoiceId: string; addressee: string }, gw: Adapters = gateway, now = new Date()) {
  if (!ALLOWED.includes(staff.role)) throw new Error("forbidden");
  if (p.addressee !== "buyer" && p.addressee !== "seller") throw new Error("choose who the notice is for");
  const addressee = p.addressee;
  const { invoice: i, offer, dpd, due } = await noticeCheck(db, p.invoiceId, addressee, now);
  const [live] = await db.select({ id: legalNotices.id }).from(legalNotices).where(and(eq(legalNotices.invoiceId, i.id), eq(legalNotices.addressee, addressee), inArray(legalNotices.status, ["issued", "handed_over"])));
  if (live) throw new Error(`a notice to the ${addressee} is already open on this invoice`);
  const toId = addressee === "buyer" ? i.buyerId : i.sellerId;
  const [[to], [seller], [buyer], [va]] = await Promise.all([
    db.select().from(businesses).where(eq(businesses.id, toId)),
    db.select().from(businesses).where(eq(businesses.id, i.sellerId)),
    db.select().from(businesses).where(eq(businesses.id, i.buyerId)),
    db.select().from(virtualAccounts).where(eq(virtualAccounts.invoiceId, i.id)),
  ]);
  const cureBy = addDays(isoDay(now), COLLECTIONS.legalNoticeCureDays);
  const total = due.principal + due.discount + due.penal;
  // The number comes from the row, so the row goes in first (in a transaction with the stored document) and the PDF is made from it.
  const row = await db.transaction(async (tx) => {
    const [r] = await tx.insert(legalNotices).values({
      invoiceId: i.id, addressee, addresseeId: toId, amountDue: total, breakdown: { principal: String(due.principal), discount: String(due.discount), penal: String(due.penal) },
      dpd, cureBy, documentRef: "pending", issuedBy: staff.id, issuedAt: now,
    }).returning();
    const pdf = await renderPdf(legalNotice({
      noticeNo: noticeNo(r.seq), addressee, to, seller, buyer, invoice: { invoiceNumber: i.invoiceNumber, invoiceDate: i.invoiceDate, dueDate: i.dueDate, amount: i.amount }, dpd, due,
      cureBy, cureDays: COLLECTIONS.legalNoticeCureDays, collection: va ? { accountNumber: va.accountNumber, ifsc: va.ifsc } : null,
      financier: await financierFor(db, offer), country: termsFor(seller.country), now,
    }), { footer: `Notice ${noticeNo(r.seq)}` });
    const doc = await putGenerated(pdf);
    const [done] = await tx.update(legalNotices).set({ documentRef: doc.ref }).where(eq(legalNotices.id, r.id)).returning();
    await tx.insert(auditLog).values({ actorId: staff.id, action: "legal_notice.issue", entity: "invoice", entityId: i.id, after: { noticeNo: noticeNo(r.seq), addressee, amountDue: String(total), cureBy } });
    return done;
  });
  await notifyBusiness(db, toId, "legal_notice", { invoiceNumber: i.invoiceNumber, amount: formatMoney(total), cureBy, noticeNo: noticeNo(row.seq), link: `/api/documents/${row.documentRef}` }, gw, now);
  return row;
}

/** After the notice period: pass the invoice to a recovery agency or lawyer. Recorded, and the addressee told. */
export async function handOver(db: Database, staff: Staff, noticeId: string, p: { agency: string; note?: string }, gw: Adapters = gateway, now = new Date()) {
  if (!ALLOWED.includes(staff.role)) throw new Error("forbidden");
  const agency = p.agency.trim();
  if (!agency) throw new Error("name the agency or lawyer");
  const [n] = await db.select().from(legalNotices).where(eq(legalNotices.id, noticeId));
  if (!n || n.status !== "issued") throw new Error("this notice is not waiting for a decision");
  if (isoDay(now) <= n.cureBy) throw new Error(`the notice period runs until ${n.cureBy}`);
  const [c] = await db.select().from(invoiceCollections).where(and(eq(invoiceCollections.invoiceId, n.invoiceId), isNull(invoiceCollections.closedAt)));
  if (!c) throw new Error("nothing is outstanding on this invoice any more");
  const [done] = await db.update(legalNotices).set({ status: "handed_over", agency, handoffNote: p.note?.trim() || null, handedOverBy: staff.id, handedOverAt: now }).where(and(eq(legalNotices.id, noticeId), eq(legalNotices.status, "issued"))).returning();
  if (!done) throw new Error("this notice is not waiting for a decision");
  const [inv] = await db.select({ no: invoices.invoiceNumber }).from(invoices).where(eq(invoices.id, n.invoiceId));
  await db.insert(auditLog).values({ actorId: staff.id, action: "legal_notice.handover", entity: "invoice", entityId: n.invoiceId, after: { noticeNo: noticeNo(n.seq), agency } });
  await notifyBusiness(db, n.addresseeId, "recovery_handoff", { invoiceNumber: inv.no, noticeNo: noticeNo(n.seq), agency }, gw, now);
  return done;
}

export const listNotices = (db: Database) => db.select({ n: legalNotices, invoiceNumber: invoices.invoiceNumber, to: businesses.legalName }).from(legalNotices)
  .innerJoin(invoices, eq(invoices.id, legalNotices.invoiceId)).innerJoin(businesses, eq(businesses.id, legalNotices.addresseeId)).orderBy(desc(legalNotices.issuedAt)).limit(200);
export { noticeNo };

/**
 * Daily worker. Close notices whose invoice was paid (or written off, when nothing was handed over), tell staff once when an invoice
 * reaches the notice threshold, and once when a notice's date has passed unpaid. Safe to run twice.
 */
export async function runLegalSweep(db: Database, gw: Adapters = gateway, now = new Date()) {
  const today = isoDay(now), n = { closed: 0, due: 0, lapsed: 0 };
  const live = await db.select({ n: legalNotices, status: invoices.status, no: invoices.invoiceNumber }).from(legalNotices).innerJoin(invoices, eq(invoices.id, legalNotices.invoiceId)).where(inArray(legalNotices.status, ["issued", "handed_over"]));
  for (const r of live) {
    const next = r.status === "paid" ? "cured" : r.status === "written_off" && r.n.status === "issued" ? "closed" : null;
    if (next) { await db.update(legalNotices).set({ status: next, closedAt: now }).where(eq(legalNotices.id, r.n.id)); n.closed++; continue; }
    if (r.n.status === "issued" && today > r.n.cureBy && (await once(db, r.n.invoiceId, `legal_lapsed_${r.n.addressee}`))) {
      await notifyStaff(db, ["admin", "compliance"], "legal_cure_lapsed", { invoiceNumber: r.no, noticeNo: noticeNo(r.n.seq), link: "/admin/collections" }, gw, now);
      n.lapsed++;
    }
  }
  const open = await db.select({ i: invoices, c: invoiceCollections }).from(invoiceCollections).innerJoin(invoices, eq(invoices.id, invoiceCollections.invoiceId)).where(and(isNull(invoiceCollections.closedAt), sql`${invoices.dueDate} <= ${isoDay(new Date(now.getTime() - COLLECTIONS.legalNoticeAfterDpd * DAY))}`));
  const noticed = new Set((await db.select({ id: legalNotices.invoiceId }).from(legalNotices)).map((x) => x.id));
  for (const { i } of open) {
    if (noticed.has(i.id) || !["overdue", "due"].includes(i.status)) continue;
    if (await once(db, i.id, "legal_due")) {
      await notifyStaff(db, ["admin", "compliance"], "legal_notice_due", { invoiceNumber: i.invoiceNumber, dpd: String(daysBetween(i.dueDate, today)), link: "/admin/collections" }, gw, now);
      n.due++;
    }
  }
  return n;
}

/** True the first time for this invoice and kind, false after: one staff alert per step, ever. */
async function once(db: Database, invoiceId: string, kind: string) {
  return (await db.insert(collectionEvents).values({ invoiceId, kind }).onConflictDoNothing().returning({ id: collectionEvents.id })).length > 0;
}
