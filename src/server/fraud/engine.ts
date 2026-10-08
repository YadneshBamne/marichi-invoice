// Advanced fraud engine. Rule-based signals with weights: each fired signal adds to the invoice's score, and a score at or above
// the case threshold (or any single high-severity signal) opens a case, which freezes the invoice until a reviewer decides.
// Every signal carries a plain-language reason, so a reviewer sees exactly why something was flagged.
// The rules look at patterns across invoices and businesses; the existing duplicate and e-invoice checks stay where they are.
import { and, asc, desc, eq, gte, inArray, lt, ne, notInArray } from "drizzle-orm";
import type { Database } from "../db/client";
import { businessBankAccounts, businesses, fraudScans, invoices } from "../db/schema";
import { openCase } from "./service";
import { formatINR } from "../../lib/money";

/** Editable in Policy (group "Fraud engine"). */
export const FRAUD = {
  caseThreshold: 60, // total score that opens a case
  velocityPerDay: 10, // invoices from one seller in 24 hours
  outlierMultiple: 5, // an invoice this many times the seller's average
  newSellerDays: 14, // a seller account younger than this...
  newSellerTicket: 10_00_000_00n, // ...raising an invoice at least this large
  circularWindowDays: 90,
};

export type Signal = { rule: string; label: string; severity: "low" | "medium" | "high"; score: number; detail: Record<string, unknown> };
const DAY = 86_400_000;
const CLOSED = ["paid", "rejected", "written_off"] as const;
const panOf = (gstin: string | null) => (gstin && gstin.length >= 12 ? gstin.slice(2, 12).toUpperCase() : null); // chars 3-12 of a GSTIN are the holder's PAN

/** Score one invoice. Pure reads: nothing is changed. */
export async function scoreInvoice(db: Database, invoiceId: string, now = new Date()): Promise<Signal[]> {
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
  if (!inv) throw new Error("invoice not found");
  const [[seller], [buyer]] = await Promise.all([
    db.select().from(businesses).where(eq(businesses.id, inv.sellerId)),
    db.select().from(businesses).where(eq(businesses.id, inv.buyerId)),
  ]);
  const out: Signal[] = [];
  const add = (s: Signal) => out.push(s);

  const since = new Date(now.getTime() - DAY);
  const [recent, history] = await Promise.all([
    db.select({ id: invoices.id }).from(invoices).where(and(eq(invoices.sellerId, inv.sellerId), gte(invoices.createdAt, since))),
    db.select({ id: invoices.id, amount: invoices.amount, buyerId: invoices.buyerId, date: invoices.invoiceDate, createdAt: invoices.createdAt }).from(invoices)
      .where(and(eq(invoices.sellerId, inv.sellerId), ne(invoices.id, inv.id), notInArray(invoices.status, ["rejected"]))).orderBy(desc(invoices.createdAt)).limit(50),
  ]);

  // 1. Velocity: a burst of invoices from one seller.
  if (recent.length >= FRAUD.velocityPerDay) add({ rule: "velocity", label: "Many invoices in one day", severity: "medium", score: 25, detail: { invoicesLast24h: recent.length, limit: FRAUD.velocityPerDay } });

  // 2. Amount outlier against this seller's own history (needs a few invoices to mean anything).
  if (history.length >= 3) {
    const avg = history.reduce((a, h) => a + h.amount, 0n) / BigInt(history.length);
    if (avg > 0n && inv.amount > avg * BigInt(FRAUD.outlierMultiple)) add({ rule: "amount_outlier", label: "Much larger than this seller's usual invoice", severity: "medium", score: 20, detail: { amount: formatINR(inv.amount), sellerAverage: formatINR(avg), times: Number(inv.amount / avg) } });
  }

  // 3. Round-number streak: several recent invoices in exact lakhs is a pattern real trade rarely shows.
  const LAKH = 1_00_000_00n;
  if (inv.amount >= 5n * LAKH && inv.amount % LAKH === 0n) {
    const lastFive = history.slice(0, 5);
    if (lastFive.filter((h) => h.amount % LAKH === 0n).length >= 3) add({ rule: "round_amounts", label: "A run of exactly round amounts", severity: "low", score: 10, detail: { amount: formatINR(inv.amount) } });
  }

  // 4. A brand-new seller account raising a large invoice.
  const ageDays = (now.getTime() - seller.createdAt.getTime()) / DAY;
  if (ageDays < FRAUD.newSellerDays && inv.amount >= FRAUD.newSellerTicket) add({ rule: "new_seller_large", label: "New seller, large invoice", severity: "medium", score: 25, detail: { accountAgeDays: Math.floor(ageDays), amount: formatINR(inv.amount) } });

  // 5. Related parties: the same PAN on both sides means the "buyer" is the seller (or its other registration).
  const sp = panOf(seller.gstin), bp = panOf(buyer.gstin);
  if ((sp && bp && sp === bp) || (seller.pan && buyer.pan && seller.pan === buyer.pan)) add({ rule: "related_party", label: "Seller and buyer share a PAN", severity: "high", score: 40, detail: { pan: sp ?? seller.pan } });

  // 6. Circular trade: money going round. A sells to B and B sells back to A, or A -> B -> C -> A, within the window.
  const win = new Date(now.getTime() - FRAUD.circularWindowDays * DAY);
  const backTo = await db.select({ id: invoices.id }).from(invoices).where(and(eq(invoices.sellerId, inv.buyerId), eq(invoices.buyerId, inv.sellerId), gte(invoices.createdAt, win), lt(invoices.createdAt, new Date(now.getTime() + 1))));
  if (backTo.length) add({ rule: "circular_trade", label: "The buyer also sells to this seller", severity: "high", score: 40, detail: { returningInvoices: backTo.length } });
  else {
    const viaBuyer = await db.select({ x: invoices.buyerId }).from(invoices).where(and(eq(invoices.sellerId, inv.buyerId), gte(invoices.createdAt, win)));
    const intoSeller = viaBuyer.length ? await db.select({ id: invoices.id }).from(invoices).where(and(inArray(invoices.sellerId, [...new Set(viaBuyer.map((v) => v.x))]), eq(invoices.buyerId, inv.sellerId), gte(invoices.createdAt, win))) : [];
    if (intoSeller.length) add({ rule: "circular_trade", label: "A three-way loop of invoices (A to B to C to A)", severity: "high", score: 45, detail: { loopInvoices: intoSeller.length } });
  }

  // 7. The same bank account behind two different businesses. Account numbers are encrypted, so compare after reading;
  // ponytail: reads all accounts. Fine at this scale; add a blind index on the account number when the table grows.
  const mine = await db.select({ n: businessBankAccounts.accountNumber }).from(businessBankAccounts).where(eq(businessBankAccounts.businessId, inv.sellerId));
  if (mine.length) {
    const others = await db.select({ n: businessBankAccounts.accountNumber, b: businessBankAccounts.businessId }).from(businessBankAccounts).where(ne(businessBankAccounts.businessId, inv.sellerId));
    const mineSet = new Set(mine.map((m) => m.n));
    const shared = others.filter((o) => mineSet.has(o.n));
    if (shared.length) add({ rule: "shared_bank_account", label: "The same bank account is used by another business", severity: "high", score: 50, detail: { otherBusinesses: [...new Set(shared.map((s) => s.b))].length } });
  }

  // 8. Possible duplicate: same buyer, same amount, same invoice date, different number.
  const twin = history.find((h) => h.buyerId === inv.buyerId && h.amount === inv.amount && h.date === inv.invoiceDate);
  if (twin) add({ rule: "possible_duplicate", label: "Same buyer, amount and date as another invoice", severity: "medium", score: 30, detail: { otherInvoice: twin.id } });

  return out;
}

export const verdict = (signals: Signal[]) => {
  const score = signals.reduce((a, s) => a + s.score, 0);
  const anyHigh = signals.some((s) => s.severity === "high");
  return { score, flag: score >= FRAUD.caseThreshold || anyHigh, severity: (score >= 90 || anyHigh ? "high" : "medium") as "high" | "medium" };
};

/** Score, record the scan, and open a case (freezing the invoice) when the verdict says so. Safe to repeat. */
export async function scanInvoice(db: Database, invoiceId: string, now = new Date()) {
  const signals = await scoreInvoice(db, invoiceId, now);
  const v = verdict(signals);
  await db.insert(fraudScans).values({ invoiceId, score: v.score, signals, scannedAt: now })
    .onConflictDoUpdate({ target: fraudScans.invoiceId, set: { score: v.score, signals, scannedAt: now } });
  let caseId: string | undefined;
  if (v.flag) {
    const [inv] = await db.select({ s: invoices.sellerId }).from(invoices).where(eq(invoices.id, invoiceId));
    const c = await openCase(db, { entityType: "invoice", entityId: invoiceId, rule: "risk_signals", subjectBusinessId: inv.s, severity: v.severity, details: { score: v.score, threshold: FRAUD.caseThreshold, signals } });
    caseId = c.id;
  }
  return { ...v, signals, caseId };
}

/** Worker: scan every live invoice that has never been scanned (catches anything the upload-time scan missed). */
export async function scanPending(db: Database, now = new Date(), limit = 50) {
  const scanned = db.select({ id: fraudScans.invoiceId }).from(fraudScans);
  const rows = await db.select({ id: invoices.id }).from(invoices).where(and(notInArray(invoices.status, [...CLOSED]), notInArray(invoices.id, scanned))).orderBy(asc(invoices.createdAt)).limit(limit);
  let flagged = 0;
  for (const r of rows) { try { if ((await scanInvoice(db, r.id, now)).flag) flagged++; } catch (e) { console.error("[fraud-scan]", r.id, (e as Error).message); } }
  return { scanned: rows.length, flagged };
}
