// Sidebar counters: "how many things are waiting for this user", cheap count queries only (runs on every page load).
import { and, count, eq, inArray, isNull } from "drizzle-orm";
import type { Database } from "../db/client";
import { agreements, businesses, disbursements, financingOffers, fraudCases, invoices, tickets, underwritingDecisions, unmatchedCredits } from "../db/schema";

const n = async (q: Promise<{ n: number }[]>) => (await q)[0].n;
const OPEN_TICKET = ["open", "in_progress", "awaiting_customer"] as const;

export async function navBadges(db: Database, user: { role: string; businessId: string | null }): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const set = (href: string, v: number) => { if (v > 0) out[href] = v; };

  if (user.role === "seller" && user.businessId) {
    const id = user.businessId;
    const [offers, toSign] = await Promise.all([
      n(db.select({ n: count() }).from(financingOffers).innerJoin(invoices, eq(invoices.id, financingOffers.invoiceId)).where(and(eq(invoices.sellerId, id), eq(financingOffers.status, "open")))),
      n(db.select({ n: count() }).from(agreements).where(and(eq(agreements.businessId, id), eq(agreements.status, "sent"), inArray(agreements.kind, ["master", "invoice_schedule"])))),
    ]);
    set("/seller/invoices", offers); set("/seller/agreements", toSign);
  } else if (user.role === "buyer" && user.businessId) {
    set("/buyer/invoices", await n(db.select({ n: count() }).from(invoices).where(and(eq(invoices.buyerId, user.businessId), eq(invoices.status, "sent_for_confirmation")))));
  } else if (["admin", "ops", "compliance"].includes(user.role)) {
    const [kyb, referred, approvals, failed, fraud, unmatched, open] = await Promise.all([
      n(db.select({ n: count() }).from(businesses).where(inArray(businesses.kybStatus, ["under_review", "submitted"]))),
      n(db.select({ n: count() }).from(underwritingDecisions).innerJoin(invoices, eq(invoices.id, underwritingDecisions.invoiceId)).where(and(eq(underwritingDecisions.decision, "referred"), eq(invoices.status, "eligible")))),
      n(db.select({ n: count() }).from(disbursements).where(and(eq(disbursements.status, "pending"), eq(disbursements.needsApproval, true), isNull(disbursements.approvedAt)))),
      n(db.select({ n: count() }).from(disbursements).where(eq(disbursements.status, "failed"))),
      n(db.select({ n: count() }).from(fraudCases).where(eq(fraudCases.status, "open"))),
      n(db.select({ n: count() }).from(unmatchedCredits).where(isNull(unmatchedCredits.resolvedAt))),
      n(db.select({ n: count() }).from(tickets).where(inArray(tickets.status, [...OPEN_TICKET]))),
    ]);
    set("/admin/kyb", kyb); set("/admin/underwriting", referred); set("/admin/disbursements", approvals + failed);
    set("/admin/fraud", fraud); set("/admin/collections", unmatched); set("/admin/support", open);
  }
  return out;
}
