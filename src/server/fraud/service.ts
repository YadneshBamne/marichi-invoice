import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Database, Tx } from "../db/client";
import { auditLog, blacklist, businesses, fraudCaseNotes, fraudCases, invoices, strReports } from "../db/schema";
import { gateway, type Adapters } from "../integrations/gateway";
import { notifyStaff } from "../notify";

export const KYB_AML_RULE = "kyb_aml_hit"; // resolved through KYB review, never through this queue

const SEVERITY: Record<string, "low" | "medium" | "high"> = {
  kyb_aml_hit: "high", duplicate_across_sellers: "high", irn_cancelled: "high", irn_not_found: "high", irn_mismatch: "medium",
};
const RESOLVERS = ["compliance", "admin"]; // PRD: sanctions/fraud findings are compliance decisions
const HANDLERS = ["ops", "compliance", "admin"];

/** Open (or find) a case. A repeat trigger while one is open is the same case. Callable inside a transaction. */
export async function openCase(
  db: Database | Tx,
  p: { entityType: "invoice" | "business"; entityId: string; rule: string; subjectBusinessId?: string; details?: Record<string, unknown>; severity?: "low" | "medium" | "high" },
) {
  const [row] = await db.insert(fraudCases).values({
    entityType: p.entityType, entityId: p.entityId, ruleTriggered: p.rule, severity: p.severity ?? SEVERITY[p.rule] ?? "medium",
    subjectBusinessId: p.subjectBusinessId, details: p.details,
  }).onConflictDoNothing().returning();
  return { created: !!row, id: row?.id };
}

/** Worker: alert staff to cases they haven't been told about yet. Decoupled from the transaction that opened the case. */
export async function notifyNewCases(db: Database, gw: Adapters = gateway) {
  const fresh = await db.select().from(fraudCases).where(and(isNull(fraudCases.notifiedAt), eq(fraudCases.status, "open")));
  for (const c of fresh) {
    await notifyStaff(db, ["compliance", "admin"], "fraud_case_opened", { caseId: c.id, rule: c.ruleTriggered, severity: c.severity }, gw);
    await db.update(fraudCases).set({ notifiedAt: new Date() }).where(eq(fraudCases.id, c.id));
  }
  return fresh.length;
}

// ---- Freeze / ban gates (called by underwriting, offers, disbursement, invoice creation) ----

export async function isBlacklisted(db: Database | Tx, businessId: string) {
  const [b] = await db.select({ id: blacklist.id }).from(blacklist).where(and(eq(blacklist.businessId, businessId), isNull(blacklist.liftedAt)));
  return !!b;
}

/**
 * An invoice with an open case, or with a blacklisted seller/buyer, can't move forward (PRD Module 12:
 * flagged transactions are frozen pending investigation).
 */
export async function assertNotFrozen(db: Database | Tx, invoiceId: string) {
  const [open] = await db.select({ id: fraudCases.id }).from(fraudCases)
    .where(and(eq(fraudCases.entityType, "invoice"), eq(fraudCases.entityId, invoiceId), eq(fraudCases.status, "open")));
  if (open) throw new Error("FROZEN_FRAUD_REVIEW");
  const [inv] = await db.select({ s: invoices.sellerId, b: invoices.buyerId }).from(invoices).where(eq(invoices.id, invoiceId));
  if (inv && ((await isBlacklisted(db, inv.s)) || (await isBlacklisted(db, inv.b)))) throw new Error("BLACKLISTED");
}

// ---- Queue actions ----

export async function assignCase(db: Database, caseId: string, staff: { id: string; role: string }) {
  if (!HANDLERS.includes(staff.role)) throw new Error("forbidden");
  const [c] = await db.update(fraudCases).set({ assignedTo: staff.id }).where(and(eq(fraudCases.id, caseId), eq(fraudCases.status, "open"))).returning();
  if (!c) throw new Error("case not found or already closed");
  await db.insert(auditLog).values({ actorId: staff.id, action: "fraud.assign", entity: "fraud_case", entityId: caseId });
}

export async function addCaseNote(db: Database, caseId: string, staff: { id: string; role: string }, note: string) {
  if (!HANDLERS.includes(staff.role)) throw new Error("forbidden");
  if (!note.trim()) throw new Error("note is empty");
  const [c] = await db.select({ id: fraudCases.id }).from(fraudCases).where(eq(fraudCases.id, caseId));
  if (!c) throw new Error("case not found");
  await db.insert(fraudCaseNotes).values({ caseId, authorId: staff.id, note: note.trim() });
}

export type Outcome = "cleared" | "confirmed_fraud";

/**
 * Close a case. Only compliance/admin, always with a note.
 *  - cleared: lifts the freeze; for IRN cases the invoice is released to validation again (manual override, audited).
 *  - confirmed_fraud: invoice is rejected (unless already funded), the subject is blacklisted platform-wide,
 *    and a draft STR is created for compliance to file.
 */
export async function resolveCase(db: Database, p: { caseId: string; staff: { id: string; role: string }; outcome: Outcome; note: string }, now = new Date()) {
  if (!RESOLVERS.includes(p.staff.role)) throw new Error("forbidden");
  if (!p.note.trim()) throw new Error("a resolution note is required");
  return db.transaction(async (tx) => {
    const [c] = await tx.select().from(fraudCases).where(eq(fraudCases.id, p.caseId)).for("update");
    if (!c) throw new Error("case not found");
    if (c.status !== "open") throw new Error("case is already closed");
    if (c.ruleTriggered === KYB_AML_RULE) throw new Error("KYB sanctions/PEP cases are resolved in the KYB review queue");

    let invoice: typeof invoices.$inferSelect | undefined;
    if (c.entityType === "invoice") [invoice] = await tx.select().from(invoices).where(eq(invoices.id, c.entityId)).for("update");
    const funded = !!invoice && ["financed", "due", "overdue", "paid", "written_off"].includes(invoice.status);

    if (p.outcome === "cleared" && invoice && c.ruleTriggered.startsWith("irn_")) {
      await tx.update(invoices).set({
        irnStatus: "verified", reviewNote: `manually cleared: ${p.note}`,
        ...(invoice.status === "uploaded" ? { status: "validated" as const } : {}),
      }).where(eq(invoices.id, invoice.id));
    }
    if (p.outcome === "confirmed_fraud") {
      const subject = c.subjectBusinessId ?? invoice?.sellerId;
      // Reject the invoice only if its own seller is the accused. When someone ELSE copied it (duplicate_across_sellers),
      // the original is the victim and stays as it was.
      if (invoice && !funded && subject === invoice.sellerId) {
        await tx.update(invoices).set({ status: "rejected", disputeFlag: true, reviewNote: "rejected: confirmed fraud" }).where(eq(invoices.id, invoice.id));
      }
      if (subject) {
        await tx.insert(blacklist).values({ businessId: subject, reason: `${c.ruleTriggered}: ${p.note}`, caseId: c.id }).onConflictDoNothing();
        await tx.insert(auditLog).values({ actorId: p.staff.id, action: "blacklist.add", entity: "business", entityId: subject, after: { caseId: c.id } });
      }
      await tx.insert(strReports).values({
        caseId: c.id, narrative: `Rule ${c.ruleTriggered} on ${c.entityType} ${c.entityId}. ${JSON.stringify(c.details ?? {})}. Reviewer: ${p.note}`,
      }).onConflictDoNothing();
    }
    await tx.update(fraudCases).set({ status: "closed", outcome: p.outcome, resolution: p.note, resolvedBy: p.staff.id, resolvedAt: now }).where(eq(fraudCases.id, c.id));
    await tx.insert(auditLog).values({ actorId: p.staff.id, action: `fraud.${p.outcome}`, entity: "fraud_case", entityId: c.id, after: { note: p.note, rule: c.ruleTriggered } });
    return { outcome: p.outcome };
  });
}

/** Record that the STR was filed with the regulator. */
export async function fileStr(db: Database, p: { caseId: string; reference: string; staff: { id: string; role: string } }, now = new Date()) {
  if (!RESOLVERS.includes(p.staff.role)) throw new Error("forbidden");
  if (!p.reference.trim()) throw new Error("regulator reference is required");
  const [r] = await db.update(strReports).set({ status: "filed", reference: p.reference.trim(), filedBy: p.staff.id, filedAt: now })
    .where(and(eq(strReports.caseId, p.caseId), eq(strReports.status, "draft"))).returning();
  if (!r) throw new Error("no draft STR for this case");
  await db.insert(auditLog).values({ actorId: p.staff.id, action: "str.filed", entity: "fraud_case", entityId: p.caseId, after: { reference: r.reference } });
}

/** Admin lifts a ban (e.g. confirmed mistake). Audited, note required. */
export async function liftBlacklist(db: Database, p: { businessId: string; staff: { id: string; role: string }; note: string }, now = new Date()) {
  if (p.staff.role !== "admin") throw new Error("forbidden");
  if (!p.note.trim()) throw new Error("a note is required");
  const [b] = await db.update(blacklist).set({ liftedAt: now, liftedBy: p.staff.id })
    .where(and(eq(blacklist.businessId, p.businessId), isNull(blacklist.liftedAt))).returning();
  if (!b) throw new Error("business is not blacklisted");
  await db.insert(auditLog).values({ actorId: p.staff.id, action: "blacklist.lift", entity: "business", entityId: p.businessId, after: { note: p.note } });
}

/** Queue rows with the context a reviewer needs on one screen. */
export async function listCases(db: Database, status: "open" | "closed" = "open") {
  const cases = await db.select().from(fraudCases).where(eq(fraudCases.status, status)).orderBy(desc(fraudCases.createdAt)).limit(200);
  const invIds = cases.filter((c) => c.entityType === "invoice").map((c) => c.entityId);
  const invs = invIds.length ? await db.select().from(invoices).where(inArray(invoices.id, invIds)) : [];
  const bizIds = [...new Set([...cases.map((c) => c.subjectBusinessId), ...cases.filter((c) => c.entityType === "business").map((c) => c.entityId), ...invs.flatMap((i) => [i.sellerId, i.buyerId])].filter((x): x is string => !!x))];
  const biz = bizIds.length ? await db.select({ id: businesses.id, name: businesses.legalName }).from(businesses).where(inArray(businesses.id, bizIds)) : [];
  const caseIds = cases.map((c) => c.id);
  const notes = caseIds.length ? await db.select().from(fraudCaseNotes).where(inArray(fraudCaseNotes.caseId, caseIds)).orderBy(fraudCaseNotes.createdAt) : [];
  const strs = caseIds.length ? await db.select().from(strReports).where(inArray(strReports.caseId, caseIds)) : [];
  const name = (id?: string | null) => biz.find((b) => b.id === id)?.name ?? null;
  return cases.map((c) => {
    const inv = invs.find((i) => i.id === c.entityId);
    return {
      ...c,
      invoice: inv ? { number: inv.invoiceNumber, amount: inv.amount, status: inv.status, seller: name(inv.sellerId), buyer: name(inv.buyerId) } : null,
      subjectName: name(c.subjectBusinessId ?? (c.entityType === "business" ? c.entityId : inv?.sellerId)),
      notes: notes.filter((n) => n.caseId === c.id),
      str: strs.find((s) => s.caseId === c.id) ?? null,
    };
  });
}
