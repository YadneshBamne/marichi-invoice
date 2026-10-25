// Supply chain finance: buyer-led programmes. The buyer applies; staff approve it with a limit and a price based on the buyer's
// credit; the buyer invites its suppliers in bulk; a supplier that joins is financed at the programme price, up to the limit.
// The supplier's own checks (verification, fraud screening, underwriting approval) still apply to every invoice.
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Database, Tx } from "../db/client";
import { auditLog, businesses, buyerSellerRelationships, financingOffers, invoices, scfProgrammes, scfSuppliers, users } from "../db/schema";
import { gateway, type Adapters } from "../integrations/gateway";
import { notifyBusiness } from "../notify";
import { formatMoney } from "../../lib/money";
import { market } from "../../lib/countries";
import { PROGRAMME_TERMS_VERSION } from "../agreements/templates";
import { assertFlag } from "../flags/service";

export const SCF = {
  minDiscountBps: 400, // 4% a year
  maxDiscountBps: 2400,
  maxAdvanceBps: 9800, // never advance more than 98% of an invoice
  maxLimit: 100_00_00_000_00n, // ₹100 Cr per programme
  maxInvitesPerBatch: 500,
};

const STAFF = ["ops", "admin"];
export type Actor = { id: string; role: string; businessId: string | null };
const live = ["requested", "active", "paused"];

export async function programmeOf(db: Database | Tx, buyerId: string) {
  const [p] = await db.select().from(scfProgrammes).where(and(eq(scfProgrammes.buyerId, buyerId), inArray(scfProgrammes.status, live)));
  return p;
}

export async function applyForProgramme(db: Database, actor: Actor, p: { name: string; limit: bigint; acceptTerms?: boolean }, now = new Date()) {
  if (actor.role !== "buyer" || !actor.businessId) throw new Error("FORBIDDEN");
  assertFlag("scf", actor.businessId);
  if (!p.name.trim()) throw new Error("name the programme");
  if (p.limit <= 0n || p.limit > SCF.maxLimit) throw new Error("the requested limit is outside what a programme can be");
  if (!p.acceptTerms) throw new Error("read and accept the supplier finance programme terms");
  const [b] = await db.select().from(businesses).where(eq(businesses.id, actor.businessId));
  if (b.kybStatus !== "approved") throw new Error("your verification is not approved yet");
  if (await programmeOf(db, actor.businessId)) throw new Error("your company already has a programme");
  const [row] = await db.insert(scfProgrammes).values({ buyerId: actor.businessId, name: p.name.trim(), requestedLimit: p.limit, termsVersion: PROGRAMME_TERMS_VERSION, termsAcceptedAt: now, termsAcceptedBy: actor.id }).returning();
  await db.insert(auditLog).values({ actorId: actor.id, action: "scf.apply", entity: "business", entityId: actor.businessId, after: { programmeId: row.id, limit: p.limit.toString() } });
  return row;
}

/** Staff decide. Approval fixes the limit and the price; the price is the buyer's credit, not the suppliers'. */
export async function decideProgramme(db: Database, staff: { id: string; role: string }, id: string,
  d: { decision: "approve" | "decline" | "pause" | "resume"; limit?: bigint; discountBps?: number; advanceBps?: number; note?: string }, gw: Adapters = gateway, now = new Date()) {
  if (!STAFF.includes(staff.role)) throw new Error("forbidden");
  const [p] = await db.select().from(scfProgrammes).where(eq(scfProgrammes.id, id));
  if (!p) throw new Error("programme not found");
  let set: Partial<typeof scfProgrammes.$inferInsert>;
  if (d.decision === "approve") {
    if (p.status !== "requested") throw new Error(`programme is ${p.status}`);
    if (!d.limit || d.limit <= 0n || d.limit > SCF.maxLimit) throw new Error("set a limit within the allowed range");
    if (!d.discountBps || d.discountBps < SCF.minDiscountBps || d.discountBps > SCF.maxDiscountBps) throw new Error(`the yearly discount must be between ${SCF.minDiscountBps / 100}% and ${SCF.maxDiscountBps / 100}%`);
    if (!d.advanceBps || d.advanceBps <= 0 || d.advanceBps > SCF.maxAdvanceBps) throw new Error(`the advance can be at most ${SCF.maxAdvanceBps / 100}%`);
    set = { status: "active", limit: d.limit, discountBps: d.discountBps, advanceBps: d.advanceBps };
  } else if (d.decision === "decline") {
    if (p.status !== "requested") throw new Error(`programme is ${p.status}`);
    if (!d.note?.trim()) throw new Error("say why in a note");
    set = { status: "declined" };
  } else if (d.decision === "pause") {
    if (p.status !== "active") throw new Error("only an active programme can be paused");
    set = { status: "paused" };
  } else {
    if (p.status !== "paused") throw new Error("only a paused programme can be resumed");
    set = { status: "active" };
  }
  await db.update(scfProgrammes).set({ ...set, decidedBy: staff.id, decidedAt: now, decisionNote: d.note ?? null }).where(eq(scfProgrammes.id, id));
  await db.insert(auditLog).values({ actorId: staff.id, action: `scf.${d.decision}`, entity: "business", entityId: p.buyerId, after: { programmeId: id, ...(d.limit ? { limit: d.limit.toString() } : {}), discountBps: d.discountBps ?? null, advanceBps: d.advanceBps ?? null, note: d.note ?? null } });
  const label = { approve: "active", decline: "declined", pause: "paused", resume: "active" }[d.decision];
  await notifyBusiness(db, p.buyerId, "programme_decision", { name: p.name, status: label, note: d.note ?? "" }, gw);
}

export type InviteResult = { gstin: string; result: "invited" | "already" | "not_found" | "not_verified" | "invalid" | "self" };

/** Invite suppliers by tax registration number (GSTIN, TPIN), in bulk. Only suppliers already on the platform and verified can be invited; the rest are reported back. */
export async function inviteSuppliers(db: Database, actor: Actor, gstins: string[], gw: Adapters = gateway): Promise<InviteResult[]> {
  if (actor.role !== "buyer" || !actor.businessId) throw new Error("FORBIDDEN");
  assertFlag("scf", actor.businessId);
  const prog = await programmeOf(db, actor.businessId);
  if (!prog || prog.status !== "active") throw new Error("your programme is not active");
  const list = [...new Set(gstins.map((g) => g.trim().toUpperCase()).filter(Boolean))];
  if (list.length === 0) throw new Error(`add at least one ${market().ids.taxReg.label}`);
  if (list.length > SCF.maxInvitesPerBatch) throw new Error(`invite at most ${SCF.maxInvitesPerBatch} suppliers at a time`);
  const [buyer] = await db.select().from(businesses).where(eq(businesses.id, actor.businessId));
  const out: InviteResult[] = [];
  for (const gstin of list) {
    if (!market().ids.taxReg.pattern.test(gstin)) { out.push({ gstin, result: "invalid" }); continue; }
    if (gstin === buyer.gstin) { out.push({ gstin, result: "self" }); continue; }
    const [s] = await db.select().from(businesses).where(eq(businesses.gstin, gstin));
    const [seller] = s ? await db.select({ id: users.id }).from(users).where(and(eq(users.businessId, s.id), eq(users.role, "seller"))).limit(1) : [];
    if (!s || !seller) { out.push({ gstin, result: "not_found" }); continue; }
    if (s.kybStatus !== "approved") { out.push({ gstin, result: "not_verified" }); continue; }
    const [have] = await db.select().from(scfSuppliers).where(and(eq(scfSuppliers.programmeId, prog.id), eq(scfSuppliers.sellerId, s.id)));
    if (have && have.status !== "declined" && have.status !== "removed") { out.push({ gstin, result: "already" }); continue; }
    if (have) await db.update(scfSuppliers).set({ status: "invited", invitedAt: new Date(), respondedAt: null }).where(eq(scfSuppliers.id, have.id));
    else await db.insert(scfSuppliers).values({ programmeId: prog.id, sellerId: s.id });
    await notifyBusiness(db, s.id, "programme_invite", { buyer: buyer.displayName ?? buyer.legalName, name: prog.name, rate: String((prog.discountBps ?? 0) / 100) }, gw);
    out.push({ gstin, result: "invited" });
  }
  await db.insert(auditLog).values({ actorId: actor.id, action: "scf.invite", entity: "business", entityId: actor.businessId, after: { invited: out.filter((r) => r.result === "invited").length, total: list.length } });
  return out;
}

export async function removeSupplier(db: Database, actor: Actor, programmeId: string, sellerId: string) {
  const [p] = await db.select().from(scfProgrammes).where(eq(scfProgrammes.id, programmeId));
  if (!p || p.buyerId !== actor.businessId || actor.role !== "buyer") throw new Error("FORBIDDEN");
  await db.update(scfSuppliers).set({ status: "removed", respondedAt: new Date() }).where(and(eq(scfSuppliers.programmeId, programmeId), eq(scfSuppliers.sellerId, sellerId), inArray(scfSuppliers.status, ["invited", "active"])));
}

/** The supplier answers. Joining also links the buyer so invoices can be raised on it. */
export async function respondInvite(db: Database, actor: Actor, programmeId: string, accept: boolean, now = new Date(), acceptTerms = false) {
  if (accept && !acceptTerms) throw new Error("read and accept the supplier finance programme terms to join");
  if (actor.role !== "seller" || !actor.businessId) throw new Error("FORBIDDEN");
  const [inv] = await db.select({ s: scfSuppliers, p: scfProgrammes }).from(scfSuppliers).innerJoin(scfProgrammes, eq(scfProgrammes.id, scfSuppliers.programmeId))
    .where(and(eq(scfSuppliers.programmeId, programmeId), eq(scfSuppliers.sellerId, actor.businessId)));
  if (!inv || inv.s.status !== "invited") throw new Error("there is no open invitation");
  await db.transaction(async (tx) => {
    await tx.update(scfSuppliers).set({ status: accept ? "active" : "declined", respondedAt: now, ...(accept ? { termsVersion: PROGRAMME_TERMS_VERSION, termsAcceptedAt: now } : {}) }).where(eq(scfSuppliers.id, inv.s.id));
    if (accept) await tx.insert(buyerSellerRelationships).values({ buyerId: inv.p.buyerId, sellerId: actor.businessId!, creditTermsDays: 60 }).onConflictDoNothing();
    await tx.insert(auditLog).values({ actorId: actor.id, action: `scf.${accept ? "join" : "decline"}`, entity: "business", entityId: actor.businessId!, after: { programmeId } });
  });
}

/** Terms for an invoice: the programme price if the buyer runs an active programme and the seller is in it. */
export async function termsFor(db: Database | Tx, buyerId: string, sellerId: string) {
  const [r] = await db.select({ p: scfProgrammes }).from(scfProgrammes).innerJoin(scfSuppliers, eq(scfSuppliers.programmeId, scfProgrammes.id))
    .where(and(eq(scfProgrammes.buyerId, buyerId), eq(scfProgrammes.status, "active"), eq(scfSuppliers.sellerId, sellerId), eq(scfSuppliers.status, "active")));
  return r?.p ?? null;
}

/** Advances committed on this programme: accepted offers for its buyer's invoices that have not been repaid. */
export async function utilisation(db: Database | Tx, buyerId: string) {
  const [r] = await db.select({ v: sql<string>`coalesce(sum(${financingOffers.advanceAmount}), 0)` }).from(financingOffers)
    .innerJoin(invoices, eq(invoices.id, financingOffers.invoiceId))
    .innerJoin(scfProgrammes, and(eq(scfProgrammes.buyerId, invoices.buyerId), inArray(scfProgrammes.status, live)))
    .innerJoin(scfSuppliers, and(eq(scfSuppliers.programmeId, scfProgrammes.id), eq(scfSuppliers.sellerId, invoices.sellerId), eq(scfSuppliers.status, "active")))
    .where(and(eq(invoices.buyerId, buyerId), eq(financingOffers.status, "accepted"), inArray(invoices.status, ["eligible", "financed", "due", "overdue"])));
  return BigInt(r.v);
}

/** Everything the buyer's programme page needs: suppliers, utilisation, the approved-invoice feed and the payment calendar. */
export async function programmeReport(db: Database, buyerId: string) {
  const prog = await programmeOf(db, buyerId);
  if (!prog) return null;
  const sup = await db.select({ s: scfSuppliers, name: businesses.legalName, gstin: businesses.gstin }).from(scfSuppliers)
    .innerJoin(businesses, eq(businesses.id, scfSuppliers.sellerId)).where(eq(scfSuppliers.programmeId, prog.id)).orderBy(asc(businesses.legalName));
  const activeIds = sup.filter((s) => s.s.status === "active").map((s) => s.s.sellerId);
  const feed = activeIds.length
    ? await db.select({ i: invoices, seller: businesses.legalName, o: financingOffers }).from(invoices).innerJoin(businesses, eq(businesses.id, invoices.sellerId))
        .leftJoin(financingOffers, and(eq(financingOffers.invoiceId, invoices.id), eq(financingOffers.status, "accepted")))
        .where(and(eq(invoices.buyerId, buyerId), inArray(invoices.sellerId, activeIds), inArray(invoices.status, ["eligible", "financed", "due", "overdue"]))).orderBy(asc(invoices.dueDate))
    : [];
  const calendar = new Map<string, { due: bigint; count: number }>();
  for (const f of feed) { const c = calendar.get(f.i.dueDate) ?? { due: 0n, count: 0 }; c.due += f.i.amount; c.count++; calendar.set(f.i.dueDate, c); }
  const financed = feed.filter((f) => f.o).reduce((a, f) => a + f.o!.advanceAmount, 0n);
  return {
    prog, suppliers: sup, used: await utilisation(db, buyerId), financed, feed,
    calendar: [...calendar.entries()].map(([date, v]) => ({ date, ...v })),
    summary: `${formatMoney(financed)} financed across ${feed.filter((f) => f.o).length} invoices`,
  };
}

/** Programmes for staff review: the queue first, then the live ones. */
export async function listProgrammes(db: Database) {
  const rows = await db.select({ p: scfProgrammes, buyer: businesses.legalName }).from(scfProgrammes).innerJoin(businesses, eq(businesses.id, scfProgrammes.buyerId)).orderBy(desc(scfProgrammes.createdAt));
  return Promise.all(rows.map(async (r) => ({ ...r, used: await utilisation(db, r.p.buyerId) })));
}

/** For the supplier: their invitations and the programmes they are part of. */
export async function invitationsFor(db: Database, sellerId: string) {
  return db.select({ s: scfSuppliers, p: scfProgrammes, buyer: businesses.legalName }).from(scfSuppliers)
    .innerJoin(scfProgrammes, eq(scfProgrammes.id, scfSuppliers.programmeId)).innerJoin(businesses, eq(businesses.id, scfProgrammes.buyerId))
    .where(and(eq(scfSuppliers.sellerId, sellerId), inArray(scfSuppliers.status, ["invited", "active"])));
}
