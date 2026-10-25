import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { auditLog, businessBankAccounts, businesses, fraudCases, ubos } from "../db/schema";
import { gateway, type Adapters } from "../integrations/gateway";
import { resolveInvites } from "../relationships/service";
import { KYB_AML_RULE, openCase } from "../fraud/service";
import { notifyBusiness } from "../notify";

export type KybStatus = typeof businesses.$inferSelect.kybStatus;
export type KybInput = {
  businessId: string;
  pan: string;
  gstin?: string; // needed for e-invoice (IRN) cross-checks on this seller's invoices
  cin?: string;
  ubos: { name: string; din?: string; shareholdingBps: number }[];
  bank: { accountNumber: string; ifsc: string; holderName: string };
};

const COMPLIANCE_CASE = KYB_AML_RULE;
/** A GSTIN belongs to one company. If a supplier already named it, the buyer takes that company over from the emailed link instead. */
async function assertGstinFree(db: Database, gstin: string, selfId: string) {
  const [other] = await db.select({ id: businesses.id }).from(businesses).where(eq(businesses.gstin, gstin));
  if (other && other.id !== selfId) throw new Error("this GSTIN is already registered on Marichi. If a supplier invited you, open the link in that email to take over the company");
}


/**
 * Submit KYB. Auto-approves only when every check is clean. (PRD Module 1 rules)
 *  - Sanctions/PEP hit  -> under_review + compliance case; never auto-approved.
 *  - Bank name mismatch -> under_review (manual reconciliation queue).
 *  - Invalid PAN        -> info_requested.
 *  - Screening provider error -> throws, status stays `submitted` (fail-closed, PRD 12.10).
 */
export async function submitKyb(db: Database, input: KybInput, gw: Adapters = gateway) {
  const [biz] = await db.select().from(businesses).where(eq(businesses.id, input.businessId));
  if (!biz) throw new Error("business not found");
  if (!["draft", "info_requested", "rejected"].includes(biz.kybStatus)) {
    throw new Error(`cannot submit KYB from status ${biz.kybStatus}`);
  }
  if (input.ubos.length === 0) throw new Error("at least one director/UBO is required");

  // External calls first (no DB tx held open across network I/O).
  const pan = await gw.kyc.verifyPan(input.pan, biz.legalName);
  const bank = await gw.kyc.verifyBankAccount(input.bank.accountNumber, input.bank.ifsc, input.bank.holderName);
  const names = [biz.legalName, ...input.ubos.map((u) => u.name)];
  const screens = await Promise.all(names.map((n) => gw.kyc.screenAml(n))); // throws => fail closed
  const uboScreens = screens.slice(1);
  const amlHit = screens.some((s) => s.hit);

  const reasons: string[] = [];
  let status: KybStatus = "approved";
  if (!pan.valid || !pan.nameMatch) {
    status = "info_requested";
    reasons.push("PAN invalid or name mismatch");
  }
  if (!bank.exists || !bank.nameMatch) {
    if (status !== "info_requested") status = "under_review";
    reasons.push("bank account not verified / name mismatch (manual reconciliation)");
  }
  if (amlHit) {
    status = "under_review"; // overrides: compliance must look at it
    reasons.push("sanctions/PEP screening hit");
  }

  await db.transaction(async (tx) => {
    await tx.update(businesses)
      .set({ pan: input.pan, cin: input.cin, gstin: input.gstin?.trim().toUpperCase(), kybStatus: status, kybNote: reasons.join("; ") || null })
      .where(eq(businesses.id, biz.id));
    await tx.delete(ubos).where(eq(ubos.businessId, biz.id));
    await tx.insert(ubos).values(
      input.ubos.map((u, i) => ({
        businessId: biz.id,
        name: u.name,
        din: u.din,
        shareholdingBps: u.shareholdingBps,
        screeningScore: uboScreens[i].score,
        screeningHit: uboScreens[i].hit,
      })),
    );
    await tx.insert(businessBankAccounts).values({
      businessId: biz.id,
      accountNumber: input.bank.accountNumber,
      ifsc: input.bank.ifsc,
      holderName: input.bank.holderName,
      verified: bank.exists && bank.nameMatch,
      nameMatch: bank.nameMatch,
    });
    if (amlHit) await openCase(tx, { entityType: "business", entityId: biz.id, rule: COMPLIANCE_CASE, subjectBusinessId: biz.id, details: { screenedNames: names } });
    await tx.insert(auditLog).values({
      action: "kyb.submit", entity: "business", entityId: biz.id,
      before: { status: biz.kybStatus }, after: { status, reasons },
    });
    if (status === "approved") await resolveInvites(tx, biz.id);
  });
  await notifyBusiness(db, biz.id, "kyb_decision", { status: status.replaceAll("_", " "), note: reasons.join("; ") }, gw);
  return { status, reasons };
}

/**
 * Light onboarding for buyers (they receive no funds): PAN + GSTIN + AML on the entity.
 * Must upgrade to full KYB (submitKyb) to sponsor an SCF program (Phase 3).
 */
export async function submitLightKyb(
  db: Database, p: { businessId: string; gstin: string; pan: string }, gw: Adapters = gateway,
) {
  const [biz] = await db.select().from(businesses).where(eq(businesses.id, p.businessId));
  if (!biz) throw new Error("business not found");
  if (!["draft", "info_requested", "rejected"].includes(biz.kybStatus)) {
    throw new Error(`cannot submit KYB from status ${biz.kybStatus}`);
  }
  const gstin = p.gstin.trim().toUpperCase();
  await assertGstinFree(db, gstin, biz.id);
  const [pan, aml] = await Promise.all([gw.kyc.verifyPan(p.pan, biz.legalName), gw.kyc.screenAml(biz.legalName)]);
  const reasons: string[] = [];
  let status: KybStatus = "approved";
  if (!pan.valid || !pan.nameMatch) { status = "info_requested"; reasons.push("PAN invalid or name mismatch"); }
  if (aml.hit) { status = "under_review"; reasons.push("sanctions/PEP screening hit"); }

  await db.transaction(async (tx) => {
    await tx.update(businesses)
      .set({ gstin, pan: p.pan, kybLevel: "light", kybStatus: status, kybNote: reasons.join("; ") || null })
      .where(eq(businesses.id, biz.id));
    if (aml.hit) await openCase(tx, { entityType: "business", entityId: biz.id, rule: COMPLIANCE_CASE, subjectBusinessId: biz.id, details: { screenedNames: [biz.legalName] } });
    await tx.insert(auditLog).values({
      action: "kyb.submit_light", entity: "business", entityId: biz.id,
      before: { status: biz.kybStatus }, after: { status, reasons },
    });
    if (status === "approved") await resolveInvites(tx, biz.id);
  });
  await notifyBusiness(db, biz.id, "kyb_decision", { status: status.replaceAll("_", " "), note: reasons.join("; ") }, gw);
  return { status, reasons };
}

export type Decision = "approve" | "reject" | "request_info";
const STAFF = ["ops", "compliance", "admin"] as const;

/** Manual review. Businesses with an open AML case can only be approved by compliance/admin. */
export async function reviewKyb(
  db: Database,
  p: { businessId: string; reviewerId: string; reviewerRole: string; decision: Decision; note: string },
  gw: Adapters = gateway,
) {
  if (!(STAFF as readonly string[]).includes(p.reviewerRole)) throw new Error("forbidden");
  if (!p.note.trim()) throw new Error("a review note is required");
  const res = await db.transaction(async (tx) => {
    const [biz] = await tx.select().from(businesses).where(eq(businesses.id, p.businessId)).for("update");
    if (!biz) throw new Error("business not found");
    if (biz.kybStatus !== "under_review" && biz.kybStatus !== "submitted") {
      throw new Error(`nothing to review (status ${biz.kybStatus})`);
    }
    const openAml = await tx.select().from(fraudCases).where(and(
      eq(fraudCases.entityId, biz.id), eq(fraudCases.ruleTriggered, COMPLIANCE_CASE), eq(fraudCases.status, "open"),
    ));
    if (p.decision === "approve" && openAml.length && p.reviewerRole === "ops") {
      throw new Error("open AML case: compliance or admin must approve");
    }
    const status: KybStatus = { approve: "approved", reject: "rejected", request_info: "info_requested" }[p.decision] as KybStatus;
    await tx.update(businesses).set({ kybStatus: status, kybNote: p.note }).where(eq(businesses.id, biz.id));
    if (status !== "info_requested") {
      await tx.update(fraudCases)
        .set({ status: "closed", outcome: status === "approved" ? "cleared" : "rejected", resolution: `${p.decision}: ${p.note}`, resolvedBy: p.reviewerId, resolvedAt: new Date() })
        .where(and(eq(fraudCases.entityId, biz.id), eq(fraudCases.ruleTriggered, COMPLIANCE_CASE), eq(fraudCases.status, "open")));
    }
    await tx.insert(auditLog).values({
      actorId: p.reviewerId, action: `kyb.${p.decision}`, entity: "business", entityId: biz.id,
      before: { status: biz.kybStatus }, after: { status, note: p.note },
    });
    if (status === "approved") await resolveInvites(tx, biz.id);
    return { status };
  });
  await notifyBusiness(db, p.businessId, "kyb_decision", { status: res.status.replaceAll("_", " "), note: p.note }, gw);
  return res;
}

/** Gate used by offer generation, seller dashboard and agreements: no financing before KYB = approved. */
export async function assertKybApproved(db: Database, businessId: string) {
  const [b] = await db.select({ s: businesses.kybStatus }).from(businesses).where(eq(businesses.id, businessId));
  if (b?.s !== "approved") throw new Error("KYB not approved");
}
