import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { auditLog, businesses, buyerSellerRelationships, consents, invoices, mlScores, underwritingDecisions } from "../db/schema";
import { gateway, type Adapters } from "../integrations/gateway";
import { assertNotFrozen } from "../fraud/service";
import { decide, POLICY, type Inputs, type Party } from "./policy";
import { assist, ML, scoreWithModel, type MlResult } from "./ml";

const OUTSTANDING = ["financed", "due", "overdue"] as const;
const dayOf = (d: Date | string) => Math.floor(new Date(d).getTime() / 86_400_000);

type Who = { col: "sellerId" | "buyerId"; id: string };
/** On-platform repayment behaviour for one party (PRD 5: seller/buyer risk inputs). */
export async function behaviour(db: Database, who: Who, now: Date) {
  const rows = await db.select({ s: invoices.status, due: invoices.dueDate, amt: invoices.amount, sellerId: invoices.sellerId })
    .from(invoices).where(eq(invoices[who.col], who.id));
  const today = dayOf(now);
  const p = { paidCount: 0, overdueCount: 0, maxDpd: 0, outstanding: 0n, rows };
  for (const r of rows) {
    if (r.s === "paid") p.paidCount++;
    if (r.s === "written_off") p.maxDpd = 999;
    if ((OUTSTANDING as readonly string[]).includes(r.s)) {
      p.outstanding += r.amt;
      const dpd = today - dayOf(r.due);
      if (dpd > 0) { p.overdueCount++; p.maxDpd = Math.max(p.maxDpd, dpd); }
    }
  }
  return p;
}

async function bureauScore(db: Database, gw: Adapters, businessId: string, pan: string | null, required: boolean) {
  const [consent] = await db.select().from(consents)
    .where(and(eq(consents.businessId, businessId), eq(consents.purpose, "bureau_pull"))).orderBy(desc(consents.createdAt)).limit(1);
  if (!consent) {
    if (required) throw new Error("CONSENT_REQUIRED");
    return null;
  }
  if (!pan) return null;
  // A thrown error (bureau down) propagates: no decision is finalised without a bureau result (PRD 12.5).
  const r = await gw.bureau.pull(pan, consent.id);
  return r.noHit ? null : r.score;
}

export async function recordConsent(db: Database, p: { businessId: string; userId?: string; text: string; ip?: string }) {
  await db.insert(consents).values({ businessId: p.businessId, userId: p.userId, purpose: "bureau_pull", text: p.text, ip: p.ip });
}

/** Underwrite one `eligible` invoice. Idempotent: an existing decision is returned unchanged. */
export async function underwriteInvoice(db: Database, invoiceId: string, gw: Adapters = gateway, now = new Date()) {
  const [existing] = await db.select().from(underwritingDecisions).where(eq(underwritingDecisions.invoiceId, invoiceId));
  if (existing) return existing;

  const [inv] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
  if (!inv) throw new Error("invoice not found");
  if (inv.status !== "eligible") throw new Error(`invoice is not eligible for underwriting (${inv.status})`);
  if (inv.disputeFlag) throw new Error("invoice is disputed");
  await assertNotFrozen(db, invoiceId); // open fraud case / blacklisted party

  const [[seller], [buyer], [rel]] = await Promise.all([
    db.select().from(businesses).where(eq(businesses.id, inv.sellerId)),
    db.select().from(businesses).where(eq(businesses.id, inv.buyerId)),
    db.select().from(buyerSellerRelationships).where(and(eq(buyerSellerRelationships.sellerId, inv.sellerId), eq(buyerSellerRelationships.buyerId, inv.buyerId))),
  ]);
  if (seller.kybStatus !== "approved" || buyer.kybStatus !== "approved" || !rel) throw new Error("parties not verified or not linked");

  const [sb, bb] = await Promise.all([
    behaviour(db, { col: "sellerId", id: seller.id }, now),
    behaviour(db, { col: "buyerId", id: buyer.id }, now),
  ]);
  const [sellerBureau, buyerBureau] = await Promise.all([
    bureauScore(db, gw, seller.id, seller.pan, true),
    bureauScore(db, gw, buyer.id, buyer.pan, false),
  ]);
  // Outstanding in the seller's industry across all sellers, for the platform's concentration limit
  const sector = seller.industry?.trim() || null;
  const sectorRows = sector
    ? await db.select({ a: invoices.amount }).from(invoices).innerJoin(businesses, eq(businesses.id, invoices.sellerId))
      .where(and(sql`lower(${businesses.industry}) = ${sector.toLowerCase()}`, inArray(invoices.status, [...OUTSTANDING])))
    : [];
  const party = (b: typeof sb, score: number | null): Party => ({ bureauScore: score, paidCount: b.paidCount, overdueCount: b.overdueCount, maxDpd: b.maxDpd });
  const inputs: Inputs = {
    invoiceAmount: inv.amount,
    tenorDays: dayOf(inv.dueDate) - dayOf(now),
    irnStatus: inv.irnStatus,
    seller: { ...party(sb, sellerBureau), outstanding: sb.outstanding, limit: seller.creditLimit > 0n ? seller.creditLimit : POLICY.defaultSellerLimit },
    buyer: {
      ...party(bb, buyerBureau),
      outstandingForSeller: bb.rows.filter((r) => r.sellerId === seller.id && (OUTSTANDING as readonly string[]).includes(r.s)).reduce((a, r) => a + r.amt, 0n),
      cap: rel.maxExposure ?? POLICY.defaultBuyerCap,
    },
    concentration: { buyerTotal: bb.outstanding, sector, sectorTotal: sectorRows.reduce((a, r) => a + r.a, 0n) },
  };
  const rules = decide(inputs);
  let out = rules;
  // The scoring model runs beside the rules. It must never be able to break underwriting, and in assist mode it can only tighten.
  let ml: MlResult | null = null;
  if (ML.mode >= 1) {
    try {
      ml = scoreWithModel(inputs);
      const flag = assist(rules.decision, rules.grade, ml);
      if (flag) out = { ...rules, decision: "referred", reasons: [...rules.reasons, flag] };
    } catch (e) { console.error("[ml]", (e as Error).message); }
  }

  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx.insert(underwritingDecisions).values({
        invoiceId, decision: out.decision, riskGrade: out.grade, pd: out.pd,
        advanceRateBps: out.advanceRateBps, discountRateBps: out.discountRateBps,
        reasons: out.reasons,
        inputs: JSON.parse(JSON.stringify(inputs, (_, v) => (typeof v === "bigint" ? v.toString() : v))),
      }).returning();
      if (ml) {
        await tx.insert(mlScores).values({
          invoiceId, version: ml.version, pd: ml.pd.toFixed(6), grade: ml.grade, rulesGrade: rules.grade, rulesDecision: rules.decision,
          finalDecision: out.decision, reasons: ml.reasons, features: ml.features,
        }).onConflictDoNothing();
      }
      await tx.insert(auditLog).values({
        action: "underwriting.decide", entity: "invoice", entityId: invoiceId,
        after: { decision: out.decision, grade: out.grade },
      });
      return row;
    });
  } catch (e) {
    // Concurrent underwrite of the same invoice: the unique index decides, we return the winner.
    if ((e as { cause?: { code?: string } }).cause?.code === "23505") {
      return (await db.select().from(underwritingDecisions).where(eq(underwritingDecisions.invoiceId, invoiceId)))[0];
    }
    throw e;
  }
}

/** Worker job: underwrite every eligible invoice that has no decision yet. Failures are isolated per invoice. */
export async function underwriteEligible(db: Database, gw: Adapters = gateway) {
  const rows = await db.select({ id: invoices.id }).from(invoices).where(eq(invoices.status, "eligible"));
  let done = 0;
  for (const r of rows) {
    try { await underwriteInvoice(db, r.id, gw); done++; } catch (e) { console.error("[underwrite]", r.id, (e as Error).message); }
  }
  return done;
}

/** Credit-analyst review of a `referred` decision. Approves at the matrix terms the engine already priced. */
export async function reviewUnderwriting(
  db: Database, p: { decisionId: string; reviewerId: string; reviewerRole: string; outcome: "approve" | "decline"; note: string },
) {
  if (!["ops", "admin"].includes(p.reviewerRole)) throw new Error("forbidden");
  if (!p.note.trim()) throw new Error("a review note is required");
  return db.transaction(async (tx) => {
    const [d] = await tx.select().from(underwritingDecisions).where(eq(underwritingDecisions.id, p.decisionId)).for("update");
    if (!d) throw new Error("decision not found");
    if (d.decision !== "referred") throw new Error(`nothing to review (${d.decision})`);
    const decision = p.outcome === "approve" ? "approved" : "declined";
    await tx.update(underwritingDecisions)
      .set({ decision, decidedBy: `manual:${p.reviewerId}`, reviewNote: p.note }).where(eq(underwritingDecisions.id, d.id));
    await tx.insert(auditLog).values({
      actorId: p.reviewerId, action: `underwriting.${p.outcome}`, entity: "invoice", entityId: d.invoiceId,
      before: { decision: d.decision }, after: { decision, note: p.note },
    });
    return { decision };
  });
}

export const pendingReviews = (db: Database) =>
  db.select({ d: underwritingDecisions, inv: invoices }).from(underwritingDecisions)
    .innerJoin(invoices, eq(invoices.id, underwritingDecisions.invoiceId))
    .where(and(eq(underwritingDecisions.decision, "referred"), inArray(invoices.status, ["eligible"])));
