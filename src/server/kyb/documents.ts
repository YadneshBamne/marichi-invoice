// Company documents for verification. The company uploads each one; we read it (free, open-source reading), compare it with what the
// company declared, and show the reviewer both the values and any doubts. Reading never approves or rejects anything by itself.
import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "../db/client";
import { auditLog, businessBankAccounts, businessDocuments, businesses } from "../db/schema";
import { assertCan } from "../permissions";
import { putDocument } from "../vault";
import { imageText, pdfText } from "../integrations/ocr/text";
import { compareDocument, parseDocument, type DocFields } from "../integrations/ocr/doc-parse";
import { fingerprint, forensicSignals } from "../integrations/ocr/forensics";
import { market } from "../../lib/countries";

export type Actor = { id: string; role: string; orgRole?: string | null; businessId: string | null };
const IMAGES = new Set(["image/png", "image/jpeg"]);
const specOf = (kind: string) => market().documents.find((d) => d.kind === kind);

export async function uploadBusinessDocument(
  db: Database, actor: Actor, p: { kind: string; bytes: Buffer; mime: string; filename: string; validUntil?: string | null }, now = new Date(),
) {
  assertCan(actor, "company.edit");
  if (!actor.businessId) throw new Error("no company linked to this account");
  const spec = specOf(p.kind);
  if (!spec) throw new Error("that kind of document is not asked for here");
  let validUntil: string | null = null;
  if (spec.expires) {
    if (!p.validUntil || !/^\d{4}-\d{2}-\d{2}$/.test(p.validUntil)) throw new Error("enter the date this document is valid until");
    if (p.validUntil < now.toISOString().slice(0, 10)) throw new Error("that document has already expired");
    validUntil = p.validUntil;
  }
  const { ref, hash } = await putDocument(p.bytes, p.mime); // type and size checks live here

  let extracted: DocFields | null = null;
  const flags: string[] = [];
  let reading: "read" | "unreadable" = "read";
  try {
    const text = p.mime === "application/pdf" ? (await pdfText(new Uint8Array(p.bytes))).text : IMAGES.has(p.mime) ? await imageText(new Uint8Array(p.bytes)) : "";
    extracted = parseDocument(p.kind, text);
  } catch { reading = "unreadable"; }

  const [biz] = await db.select().from(businesses).where(eq(businesses.id, actor.businessId));
  if (!biz) throw new Error("company not found");
  const [bank] = await db.select().from(businessBankAccounts).where(eq(businessBankAccounts.businessId, biz.id)).orderBy(businessBankAccounts.createdAt).limit(1);
  if (extracted) flags.push(...compareDocument(p.kind, extracted, {
    legalName: biz.legalName, tradeName: biz.displayName, kybTaxId: biz.pan, taxReg: biz.gstin, companyReg: biz.cin, udyam: biz.udyam, bankAccount: bank?.accountNumber, bankCode: bank?.ifsc,
  }));
  else flags.push("Nothing could be read from this file. A person should look at it.");
  if (p.mime === "application/pdf") for (const s of forensicSignals(await fingerprint(new Uint8Array(p.bytes)), { now, history: [] })) flags.push(s.label + ".");

  return db.transaction(async (tx) => {
    await tx.update(businessDocuments).set({ supersededAt: now }).where(and(eq(businessDocuments.businessId, biz.id), eq(businessDocuments.kind, p.kind), isNull(businessDocuments.supersededAt)));
    const [row] = await tx.insert(businessDocuments).values({
      businessId: biz.id, kind: p.kind, documentRef: ref, documentHash: hash, filename: p.filename.slice(0, 120), reading, extracted, flags, validUntil, uploadedBy: actor.id,
    }).returning();
    await tx.insert(auditLog).values({ actorId: actor.id, action: "kyb.document_uploaded", entity: "business", entityId: biz.id, after: { kind: p.kind, flags: flags.length, reading } });
    return row;
  });
}

/** The newest document of each kind. */
export const currentDocuments = (db: Database, businessId: string) =>
  db.select().from(businessDocuments).where(and(eq(businessDocuments.businessId, businessId), isNull(businessDocuments.supersededAt))).orderBy(businessDocuments.createdAt);

/** Labels of the required documents this company has not uploaded yet. */
export async function missingRequired(db: Database, businessId: string): Promise<string[]> {
  const have = new Set((await currentDocuments(db, businessId)).map((d) => d.kind));
  return market().documents.filter((d) => d.required && !have.has(d.kind)).map((d) => d.label);
}
