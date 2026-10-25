// Checks that keep running after a company is approved or an invoice is financed. A clean result on day one is not a clean result
// forever: sanctions lists change, a government e-invoice can be cancelled, a verification goes out of date, a licence runs out.
// Each job is safe to run twice, handles an outage in a provider by skipping that item (never by passing or failing it), and is paced
// so a large book is covered over several runs rather than all at once.
import { and, asc, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { auditLog, businessDocuments, businesses, financierProfiles, financingOffers, invoices, sentReminders, ubos } from "../db/schema";
import { market } from "../../lib/countries";
import { gateway, type Adapters } from "../integrations/gateway";
import { KYB_AML_RULE, openCase } from "../fraud/service";
import { validateIrn } from "../invoices/service";
import { notifyBusiness } from "../notify";

export const MONITOR = {
  rescreenDays: 7, // how long a clean sanctions check stays fresh
  rescreenBatch: 200, // companies checked per run
  irnBatch: 500, // financed invoices looked up per run
  rekycMonths: 24, // approved verification is valid this long (PRD: every 1 to 3 years)
  rekycNoticeDays: 30, // told this long before it lapses
  licenceNoticeDays: [30, 7] as number[], // financier licence expiry warnings
};

const DAY = 86_400_000;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** True the first time for this key, false after: used so a reminder is sent once. */
async function once(db: Database, key: string, now: Date) {
  const r = await db.insert(sentReminders).values({ key, sentAt: now }).onConflictDoNothing().returning({ key: sentReminders.key });
  return r.length > 0;
}

// ---- 1. Sanctions and PEP re-screening ------------------------------------------------------------------------------------

/**
 * Re-check every approved company and its owners against the lists. A hit never clears itself: the company drops back to review, a
 * compliance case is opened, and only compliance or an admin can approve it again. The company is told only that it is under review
 * (never why), and a screening outage skips the company so it is tried again next run.
 */
export async function rescreenParties(db: Database, gw: Adapters = gateway, now = new Date()) {
  const stale = new Date(now.getTime() - MONITOR.rescreenDays * DAY);
  const due = await db.select().from(businesses)
    .where(and(eq(businesses.kybStatus, "approved"), or(isNull(businesses.amlScreenedAt), lte(businesses.amlScreenedAt, stale))))
    .orderBy(sql`${businesses.amlScreenedAt} asc nulls first`).limit(MONITOR.rescreenBatch);
  const out = { screened: 0, hits: 0, failed: 0 };
  for (const b of due) {
    const owners = await db.select().from(ubos).where(eq(ubos.businessId, b.id));
    let results: { name: string; score: number; hit: boolean }[];
    try {
      results = [];
      for (const name of [b.legalName, ...owners.map((o) => o.name)]) results.push({ name, ...(await gw.kyc.screenAml(name)) });
    } catch { out.failed++; continue; }
    const hits = results.filter((r) => r.hit);
    await db.transaction(async (tx) => {
      for (const o of owners) { const r = results.find((x) => x.name === o.name); if (r) await tx.update(ubos).set({ screeningScore: r.score, screeningHit: r.hit }).where(eq(ubos.id, o.id)); }
      await tx.update(businesses).set({
        amlScreenedAt: now,
        ...(hits.length ? { kybStatus: "under_review" as const, kybNote: "We need to review your verification again." } : {}),
      }).where(eq(businesses.id, b.id));
      if (hits.length) {
        await openCase(tx, { entityType: "business", entityId: b.id, rule: KYB_AML_RULE, subjectBusinessId: b.id, details: { source: "periodic re-screening", screenedNames: results.map((r) => r.name), matched: hits.map((h) => h.name) } });
        await tx.insert(auditLog).values({ action: "aml.rescreen_hit", entity: "business", entityId: b.id, after: { matched: hits.length } });
      }
    });
    if (hits.length) await notifyBusiness(db, b.id, "kyb_decision", { status: "under review", note: "We need to review your verification again." }, gw, now);
    out.screened++; out.hits += hits.length ? 1 : 0;
  }
  return out;
}

// ---- 2. Financed invoices whose e-invoice is cancelled later --------------------------------------------------------------

/**
 * The government's record can change after we have paid out: an e-invoice cancelled inside its window means the invoice may never have
 * been valid. Look every financed, unpaid invoice up again; a cancelled, vanished or altered record opens a compliance case and tells
 * the financier. An outage at the registry skips the invoice until next run.
 */
export async function recheckIrns(db: Database, gw: Adapters = gateway, now = new Date()) {
  const rows = await db.select().from(invoices)
    .where(and(isNotNull(invoices.irn), inArray(invoices.status, ["financed", "due", "overdue"])))
    .orderBy(sql`${invoices.irnRecheckedAt} asc nulls first`).limit(MONITOR.irnBatch);
  const out = { checked: 0, flagged: 0, skipped: 0 };
  for (const inv of rows) {
    const [[s], [b]] = await Promise.all([
      db.select({ g: businesses.gstin }).from(businesses).where(eq(businesses.id, inv.sellerId)),
      db.select({ g: businesses.gstin }).from(businesses).where(eq(businesses.id, inv.buyerId)),
    ]);
    let rule: string | null = null;
    let reason = "";
    try {
      const r = await validateIrn(gw, inv.irn!, { amount: inv.amount, date: inv.invoiceDate, sellerGstin: s?.g ?? "", buyerGstin: b?.g ?? "" });
      if (r.irnStatus === "pending") { out.skipped++; continue; } // registry unavailable
      if (r.irnStatus === "mismatch") { rule = "irn_mismatch"; reason = r.reason ?? "the registry record differs from the invoice"; }
    } catch (e) {
      const m = (e as Error).message;
      if (m === "IRN_CANCELLED") { rule = "irn_cancelled"; reason = "the e-invoice was cancelled after financing"; }
      else if (m === "IRN_NOT_FOUND") { rule = "irn_not_found"; reason = "the e-invoice is no longer found in the registry"; }
      else { out.skipped++; continue; }
    }
    await db.update(invoices).set({ irnRecheckedAt: now }).where(eq(invoices.id, inv.id));
    out.checked++;
    if (!rule) continue;
    const c = await db.transaction(async (tx) => {
      const opened = await openCase(tx, { entityType: "invoice", entityId: inv.id, rule, subjectBusinessId: inv.sellerId, details: { irn: inv.irn, found: "on re-check after financing", reason } });
      if (opened.created) await tx.insert(auditLog).values({ action: "irn.recheck_flagged", entity: "invoice", entityId: inv.id, after: { rule, reason } });
      return opened;
    });
    if (!c.created) continue; // already under review
    out.flagged++;
    const [offer] = await db.select({ f: financingOffers.financierId }).from(financingOffers).where(and(eq(financingOffers.invoiceId, inv.id), eq(financingOffers.status, "accepted")));
    if (offer?.f) await notifyBusiness(db, offer.f, "financed_invoice_flagged", { invoiceNumber: inv.invoiceNumber, reason }, gw, now);
  }
  return out;
}

// ---- 3. Periodic re-verification -------------------------------------------------------------------------------------------

/** Tell a company a month ahead, then move it to "re-verification due" when its approval is old enough. Financing waits until it is approved again. */
export async function runRekyc(db: Database, gw: Adapters = gateway, now = new Date()) {
  const months = MONITOR.rekycMonths;
  const out = { notified: 0, due: 0 };
  const rows = await db.select().from(businesses).where(and(eq(businesses.kybStatus, "approved"), isNotNull(businesses.kybApprovedAt)));
  for (const b of rows) {
    const dueAt = new Date(b.kybApprovedAt!); dueAt.setUTCMonth(dueAt.getUTCMonth() + months);
    const date = isoDay(dueAt);
    if (now >= dueAt) {
      await db.update(businesses).set({ kybStatus: "rekyc_due", kybNote: "Your periodic verification is due. Please confirm your details again." }).where(and(eq(businesses.id, b.id), eq(businesses.kybStatus, "approved")));
      await db.insert(auditLog).values({ action: "kyb.rekyc_due", entity: "business", entityId: b.id, after: { approvedAt: b.kybApprovedAt, dueAt: date } });
      await notifyBusiness(db, b.id, "kyb_rekyc_due", { date }, gw, now);
      out.due++;
    } else if (now.getTime() >= dueAt.getTime() - MONITOR.rekycNoticeDays * DAY && (await once(db, `rekyc:${b.id}:${date}:notice`, now))) {
      await notifyBusiness(db, b.id, "kyb_rekyc_soon", { date }, gw, now);
      out.notified++;
    }
  }
  return out;
}

/** Staff can call for re-verification at any time, for example after a risk flag. Financing stops until the company confirms its details. */
export async function requestRekyc(db: Database, staff: { id: string; role: string }, businessId: string, note: string, gw: Adapters = gateway, now = new Date()) {
  if (!["ops", "compliance", "admin"].includes(staff.role)) throw new Error("forbidden");
  if (note.trim().length < 5) throw new Error("say why (at least 5 characters)");
  const [b] = await db.select().from(businesses).where(eq(businesses.id, businessId));
  if (!b) throw new Error("business not found");
  if (b.kybStatus !== "approved") throw new Error(`only an approved company can be sent for re-verification (status ${b.kybStatus.replaceAll("_", " ")})`);
  await db.update(businesses).set({ kybStatus: "rekyc_due", kybNote: note.trim() }).where(eq(businesses.id, businessId));
  await db.insert(auditLog).values({ actorId: staff.id, action: "kyb.rekyc_requested", entity: "business", entityId: businessId, after: { note: note.trim() } });
  await notifyBusiness(db, businessId, "kyb_rekyc_due", { date: isoDay(now) }, gw, now);
}

// ---- 4a. Company documents that expire --------------------------------------------------------------------------------------

/** A document with a validity date (a tax clearance certificate) gets the same notices as a licence. When a required one lapses, the company is asked to verify again. */
export async function remindDocuments(db: Database, gw: Adapters = gateway, now = new Date()) {
  const docs = await db.select().from(businessDocuments).where(and(isNull(businessDocuments.supersededAt), isNotNull(businessDocuments.validUntil)));
  const today = isoDay(now);
  const out = { notices: 0, lapsed: 0 };
  for (const d of docs) {
    const spec = market().documents.find((s) => s.kind === d.kind);
    const label = spec?.label.replace(/\s*\(.*\)$/, "") ?? d.kind;
    const left = Math.ceil((Date.parse(d.validUntil!) - Date.parse(today)) / DAY);
    if (left < 0) {
      if (!(await once(db, `doc-expired:${d.id}`, now))) continue;
      await notifyBusiness(db, d.businessId, "document_expired", { document: label }, gw, now);
      if (spec?.required) {
        const r = await db.update(businesses).set({ kybStatus: "rekyc_due", kybNote: `The ${label} has expired. Upload a current one.` }).where(and(eq(businesses.id, d.businessId), eq(businesses.kybStatus, "approved"))).returning({ id: businesses.id });
        if (r.length) await db.insert(auditLog).values({ action: "kyb.document_expired", entity: "business", entityId: d.businessId, after: { kind: d.kind } });
      }
      out.lapsed++;
      continue;
    }
    const step = [...MONITOR.licenceNoticeDays].sort((a, b) => a - b).find((n) => left <= n);
    if (step === undefined || !(await once(db, `doc:${d.id}:${step}`, now))) continue;
    await notifyBusiness(db, d.businessId, "document_expiring", { document: label, days: String(left), date: d.validUntil! }, gw, now);
    out.notices++;
  }
  return out;
}

// ---- 4. Licence expiry notices ---------------------------------------------------------------------------------------------

/** A financier is warned before its licence runs out; once it has, bidding stops by itself (see assertActiveFinancier). */
export async function remindLicences(db: Database, gw: Adapters = gateway, now = new Date()) {
  const horizon = isoDay(new Date(now.getTime() + Math.max(...MONITOR.licenceNoticeDays) * DAY));
  const rows = await db.select().from(financierProfiles).where(and(eq(financierProfiles.status, "approved"), isNotNull(financierProfiles.licenceValidUntil), lte(financierProfiles.licenceValidUntil, horizon)));
  let sent = 0;
  for (const p of rows) {
    const until = p.licenceValidUntil!;
    const left = Math.ceil((Date.parse(until) - Date.parse(isoDay(now))) / DAY);
    if (left < 0) continue;
    const step = [...MONITOR.licenceNoticeDays].sort((a, b) => a - b).find((d) => left <= d); // the tightest notice that applies
    if (step === undefined || !(await once(db, `licence:${p.businessId}:${until}:${step}`, now))) continue;
    await notifyBusiness(db, p.businessId, "licence_expiring", { days: String(left), date: until }, gw, now);
    sent++;
  }
  return sent;
}
