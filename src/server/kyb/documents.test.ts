import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { businessDocuments, businesses, invoices, notifications } from "../db/schema";
import { T0, useMarket, world } from "../testkit";
import { market } from "../../lib/countries";
import { parseDocument, compareDocument, sameName } from "../integrations/ocr/doc-parse";
import { fingerprint, forensicSignals, type Fingerprint } from "../integrations/ocr/forensics";
import { currentDocuments, missingRequired, uploadBusinessDocument } from "./documents";
import { submitKyb } from "./service";
import { canViewDocument } from "../agreements/service";
import { putDocument } from "../vault";
import { scoreInvoice } from "../fraud/engine";
import { remindDocuments } from "../compliance/monitoring";
import { KYB_RULES } from "./rules";

afterEach(() => { KYB_RULES.requireDocuments = 0; useMarket("IN"); });

async function pdf(lines: string[], meta: { producer?: string; creator?: string; created?: Date; modified?: Date } = {}) {
  const d = await PDFDocument.create();
  d.setCreationDate(new Date("2026-09-01T00:00:00Z")); d.setModificationDate(new Date("2026-09-01T00:00:00Z")); // the test clock is early October 2026
  if (meta.producer) d.setProducer(meta.producer); if (meta.creator) d.setCreator(meta.creator);
  if (meta.created) d.setCreationDate(meta.created); if (meta.modified) d.setModificationDate(meta.modified);
  const p = d.addPage([595, 842]); const f = await d.embedFont(StandardFonts.Helvetica);
  lines.forEach((l, i) => p.drawText(l, { x: 40, y: 780 - i * 20, size: 11, font: f }));
  return Buffer.from(await d.save());
}

const GST_CERT = ["REGISTRATION CERTIFICATE", "Form GST REG-06", "GSTIN: 27AAAAA1111A1Z5", "Legal Name of Business: SELLER CO PRIVATE LIMITED", "Trade Name: Seller Co", "Date of Registration: 01/04/2019"];

describe("reading company documents", () => {
  it("reads a GST certificate, a PAN card, an incorporation certificate, a Udyam certificate and a bank letter", () => {
    expect(parseDocument("tax_registration", GST_CERT.join("\n"))).toMatchObject({ taxId: "27AAAAA1111A1Z5", legalName: "SELLER CO PRIVATE LIMITED", tradeName: "Seller Co", registeredOn: "2019-04-01" });
    expect(parseDocument("tax_id", "INCOME TAX DEPARTMENT\nPermanent Account Number\nABCDE1234F\nName\nSELLER CO PRIVATE LIMITED")).toMatchObject({ taxId: "ABCDE1234F", legalName: "SELLER CO PRIVATE LIMITED" });
    expect(parseDocument("incorporation", "Certificate of Incorporation\nCorporate Identity Number: U17110MH2019PTC123456\nName of the Company: SELLER CO PRIVATE LIMITED\nDate of Incorporation: 12 March 2019")).toMatchObject({ companyReg: "U17110MH2019PTC123456", legalName: "SELLER CO PRIVATE LIMITED", incorporatedOn: "2019-03-12" });
    expect(parseDocument("udyam", "UDYAM REGISTRATION CERTIFICATE\nUdyam Registration Number: UDYAM-MH-12-0001234\nName of Enterprise: SELLER CO\nType of Enterprise: Small")).toMatchObject({ udyam: "UDYAM-MH-12-0001234", legalName: "SELLER CO", enterpriseType: "small" });
    expect(parseDocument("bank_proof", "To whomsoever it may concern\nAccount Holder: Seller Co Private Limited\nAccount No: 123456789012\nIFSC: HDFC0001234")).toMatchObject({ bankAccount: "123456789012", bankCode: "HDFC0001234", holderName: "Seller Co Private Limited" });
  });

  it("reads Zambian documents by TPIN and PACRA number when the market is Zambia", () => {
    useMarket("ZM");
    expect(parseDocument("tax_registration", "ZAMBIA REVENUE AUTHORITY\nTPIN: 1000000011\nTaxpayer Name: KAFUE TRADERS LIMITED")).toMatchObject({ taxId: "1000000011", legalName: "KAFUE TRADERS LIMITED" });
    expect(parseDocument("incorporation", "PACRA\nCertificate of Incorporation\nRegistration Number: 120190012345\nCompany Name: KAFUE TRADERS LIMITED")).toMatchObject({ companyReg: "120190012345" });
  });

  it("names match despite 'Pvt Ltd', order and punctuation, and differ when they are really different", () => {
    expect(sameName("SELLER CO PRIVATE LIMITED", "Seller Co")).toBe(true);
    expect(sameName("Ltd. Seller Co Pvt", "SELLER CO PRIVATE LIMITED")).toBe(true);
    expect(sameName("Harbor Textiles Pvt Ltd", "Seller Co")).toBe(false);
    expect(sameName("", "Seller Co")).toBe(false);
  });

  it("flags a different name or number, and a document with nothing readable, but says nothing when all agrees", () => {
    const declared = { legalName: "Seller Co", taxReg: "27AAAAA1111A1Z5", kybTaxId: "ABCDE1234F" };
    expect(compareDocument("tax_registration", { taxId: "27AAAAA1111A1Z5", legalName: "SELLER CO PRIVATE LIMITED" }, declared)).toEqual([]);
    const f = compareDocument("tax_registration", { taxId: "29BBBBB2222B1Z5", legalName: "Someone Else Traders" }, declared);
    expect(f).toHaveLength(2);
    expect(f.join(" ")).toMatch(/GSTIN on the document \(29BBBBB2222B1Z5\) differs/);
    expect(f.join(" ")).toMatch(/does not match the declared name/);
    expect(compareDocument("tax_id", {}, declared)[0]).toMatch(/Nothing could be read/);
  });
});

describe("forgery signals from how a PDF was made", () => {
  const fp = (o: Partial<Fingerprint> = {}): Fingerprint => ({ producer: "Tally Prime", creator: "Tally Prime", created: "2026-10-01T09:00:00.000Z", modified: "2026-10-01T09:00:00.000Z", pages: 1, textLayer: true, ...o });
  const rules = (f: Fingerprint | null, ctx: Partial<Parameters<typeof forensicSignals>[1]> = {}) => forensicSignals(f, { now: T0, history: [], ...ctx }).map((s) => s.rule);

  it("a plain file from an accounting tool, dated sensibly, raises nothing", () => { expect(rules(fp(), { invoiceDate: "2026-10-01" })).toEqual([]); });
  it("a PDF editor, a different program changing it later, a date before the file existed, and a future date each raise their own signal", () => {
    expect(rules(fp({ producer: "iLovePDF" }))).toContain("document_editor");
    expect(rules(fp({ producer: "Adobe PDF Library", modified: "2026-10-05T09:00:00.000Z" }))).toContain("modified_after_creation");
    expect(rules(fp(), { invoiceDate: "2026-10-20" })).toContain("created_before_invoice_date");
    expect(rules(fp({ created: "2026-12-01T00:00:00.000Z" }))).toContain("created_in_future");
  });
  it("against the seller's habit: a new program and a picture instead of a digital file, but only with enough history", () => {
    const hist = [fp(), fp(), fp()];
    expect(rules(fp({ producer: "Zoho Books", creator: "Zoho Books", textLayer: false }), { history: hist })).toEqual(["template_change", "scan_instead_of_digital"]);
    expect(rules(fp({ producer: "Zoho Books", creator: "Zoho Books" }), { history: hist.slice(0, 2) })).toEqual([]);
    expect(rules(null)).toEqual([]);
  });
  it("fingerprints a real PDF: tool, dates, pages and whether it has a text layer", async () => {
    const f = await fingerprint(new Uint8Array(await pdf(["hello"], { producer: "iLovePDF", creator: "Tally Prime", created: new Date("2026-09-20T10:00:00Z"), modified: new Date("2026-10-02T11:00:00Z") })));
    expect(f).toMatchObject({ producer: "iLovePDF", creator: "Tally Prime", created: "2026-09-20T10:00:00.000Z", pages: 1, textLayer: true });
    expect(await fingerprint(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

describe("uploading verification documents", () => {
  let w: Awaited<ReturnType<typeof world>>;
  beforeEach(async () => { w = await world(); });
  const owner = () => ({ id: w.sellerActor.id, role: "seller", orgRole: "owner", businessId: w.sellerId });
  const up = async (kind: string, lines: string[], extra: { validUntil?: string; actor?: ReturnType<typeof owner> } = {}) =>
    uploadBusinessDocument(w.db, extra.actor ?? owner(), { kind, bytes: await pdf(lines), mime: "application/pdf", filename: `${kind}.pdf`, validUntil: extra.validUntil }, T0);

  it("reads the document, compares it with the declaration, and a newer file of the same kind replaces the older", async () => {
    const good = await up("tax_registration", GST_CERT);
    expect(good).toMatchObject({ reading: "read", flags: [] });
    expect(good.extracted).toMatchObject({ taxId: "27AAAAA1111A1Z5" });
    const bad = await up("tax_registration", ["GSTIN: 29BBBBB2222B1Z5", "Legal Name of Business: Totally Different Traders"]);
    expect(bad.flags.length).toBe(2);
    expect((await currentDocuments(w.db, w.sellerId)).map((d) => d.id)).toEqual([bad.id]);
    expect(await w.db.select().from(businessDocuments)).toHaveLength(2); // the older one is kept
  });

  it("a file edited in a PDF tool carries that doubt into the flags", async () => {
    const d = await uploadBusinessDocument(w.db, owner(), { kind: "tax_registration", bytes: await pdf(GST_CERT, { producer: "Sejda PDF Editor" }), mime: "application/pdf", filename: "x.pdf" }, T0);
    expect(d.flags.join(" ")).toMatch(/PDF or image editor/);
  });

  it("only a kind this country asks for, only an owner or admin, and the type and size are checked", async () => {
    await expect(up("passport", ["x"])).rejects.toThrow(/not asked for/);
    await expect(up("tax_registration", GST_CERT, { actor: { ...owner(), orgRole: "maker" } })).rejects.toThrow(/not allowed/);
    await expect(uploadBusinessDocument(w.db, owner(), { kind: "tax_registration", bytes: Buffer.from("x"), mime: "text/plain", filename: "x.txt" }, T0)).rejects.toThrow(/PDF, PNG or JPEG/);
  });

  it("lists what is still missing, and the policy switch can make submitting wait for it", async () => {
    expect(await missingRequired(w.db, w.sellerId)).toEqual(["GST registration certificate", "PAN card of the business"]);
    await up("tax_registration", GST_CERT); await up("tax_id", ["Permanent Account Number", "ABCDE1234F", "Name", "SELLER CO PRIVATE LIMITED"]);
    expect(await missingRequired(w.db, w.sellerId)).toEqual([]);
    // a new company, with the switch on
    const [b] = await w.db.insert(businesses).values({ legalName: "Newco", entityType: "pvt_ltd" }).returning();
    const input = { businessId: b.id, pan: "DEFGH4567I", gstin: "33DDDDD4444D1Z5", ubos: [{ name: "Neha", shareholdingBps: 10000 }], bank: { accountNumber: "123456789012", ifsc: "HDFC0001234", holderName: "Newco" } };
    KYB_RULES.requireDocuments = 1;
    await expect(submitKyb(w.db, input)).rejects.toThrow(/upload the required documents first: GST registration certificate; PAN card/);
    KYB_RULES.requireDocuments = 0;
    expect((await submitKyb(w.db, input)).status).toBe("approved");
  });

  it("a Udyam number is checked against its format and stored", async () => {
    const [b] = await w.db.insert(businesses).values({ legalName: "Microco", entityType: "pvt_ltd" }).returning();
    const input = { businessId: b.id, pan: "CDEFG3456H", gstin: "33CCCCC3333C1Z5", ubos: [{ name: "Mira", shareholdingBps: 10000 }], bank: { accountNumber: "123456789012", ifsc: "HDFC0001234", holderName: "Microco" } };
    await expect(submitKyb(w.db, { ...input, udyam: "not-a-number" })).rejects.toThrow(/invalid Udyam/);
    await submitKyb(w.db, { ...input, udyam: " udyam-mh-12-0001234 " });
    expect((await w.db.select().from(businesses).where(eq(businesses.id, b.id)))[0].udyam).toBe("UDYAM-MH-12-0001234");
  });

  it("only the company and staff can open its documents", async () => {
    const d = await up("tax_registration", GST_CERT);
    expect(await canViewDocument(w.db, { role: "seller", businessId: w.sellerId }, d.documentRef)).toBe(true);
    expect(await canViewDocument(w.db, { role: "compliance", businessId: null }, d.documentRef)).toBe(true);
    expect(await canViewDocument(w.db, { role: "buyer", businessId: w.buyerId }, d.documentRef)).toBe(false);
    expect(await canViewDocument(w.db, { role: "seller", businessId: w.buyerId }, d.documentRef)).toBe(false);
  });
});

describe("documents that expire", () => {
  it("Zambia: a tax clearance certificate needs a validity date, is reminded about, and when it lapses the company must verify again", async () => {
    useMarket("ZM");
    const w = await world();
    const actor = { id: w.sellerActor.id, role: "seller", orgRole: "owner", businessId: w.sellerId };
    const send = (validUntil?: string) => uploadBusinessDocument(w.db, actor, { kind: "tax_clearance", bytes: Buffer.from("%PDF-1.4"), mime: "application/pdf", filename: "tc.pdf", validUntil }, T0);
    await expect(send()).rejects.toThrow(/valid until/);
    await expect(send("2026-01-01")).rejects.toThrow(/already expired/);
    expect(market().documents.find((d) => d.kind === "tax_clearance")?.expires).toBe(true);
    await send("2026-10-20");
    const day = (n: number) => new Date(T0.getTime() + n * 86_400_000);
    const sent = async () => (await w.db.select().from(notifications)).filter((n) => n.template === "document_expiring").length;
    expect(await remindDocuments(w.db, undefined, T0)).toEqual({ notices: 1, lapsed: 0 }); // 14 days left: the 30-day notice
    await remindDocuments(w.db, undefined, day(1));
    expect(await sent()).toBeGreaterThan(0);
    const before = await sent();
    await remindDocuments(w.db, undefined, day(2));
    expect(await sent()).toBe(before); // once per step
    expect(await remindDocuments(w.db, undefined, day(9))).toMatchObject({ notices: 1 }); // 5 days left: the 7-day notice
    // lapsed: it is optional in Zambia, so only a notice; make it required and it pauses verification
    expect(await remindDocuments(w.db, undefined, day(20))).toEqual({ notices: 0, lapsed: 1 });
    expect((await w.db.select().from(businesses).where(eq(businesses.id, w.sellerId)))[0].kybStatus).toBe("approved");
  });
});

describe("the file's fingerprint in the fraud score", () => {
  it("an invoice file made with a PDF editor adds a signal, and the fingerprint is stored for next time", async () => {
    const w = await world();
    const { ref } = await putDocument(await pdf(["Invoice No: A-1"], { producer: "iLovePDF", creator: "Tally Prime" }), "application/pdf");
    const o = await w.offered();
    await w.db.update(invoices).set({ documentRef: ref }).where(eq(invoices.id, o.invoiceId));
    const signals = await scoreInvoice(w.db, o.invoiceId, T0);
    expect(signals.map((s) => s.rule)).toContain("document_editor");
    expect((await w.db.select().from(invoices).where(eq(invoices.id, o.invoiceId)))[0].docFingerprint).toMatchObject({ producer: "iLovePDF", pages: 1 });
  });
});
