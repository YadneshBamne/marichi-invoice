import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agreements, businesses, invoices, users, memberships } from "../db/schema";
import { gw, T0, world } from "../testkit";
import {
  assertReadyToDisburse, canViewDocument, completeSignature, prepareAgreements, prepareAllAccepted, readiness, signInApp, verifyWebhook,
} from "./service";
import { docText, masterAgreement } from "./templates";
import { PDFDocument } from "pdf-lib";
import { pdfSafe, renderPdf } from "./pdf";
import { readDocument } from "../vault";

let w: Awaited<ReturnType<typeof world>>;
beforeEach(async () => { w = await world(); });
const all = () => w.db.select().from(agreements);
const kinds = async () => (await all()).map((a) => `${a.kind}:${a.status}`).sort();

describe("prepareAgreements", () => {
  it("creates master + schedule + notice, requests signatures, sends the notice; re-running changes nothing", async () => {
    const offer = await w.acceptedOffer();
    await prepareAgreements(w.db, offer, gw, T0);
    expect(await kinds()).toEqual(["assignment_notice:sent", "invoice_schedule:sent", "key_facts:sent", "master:sent"]);
    const sigs = (await all()).filter((a) => a.esignRequestId);
    expect(sigs).toHaveLength(2);
    await prepareAgreements(w.db, offer, gw, T0);
    expect(await all()).toHaveLength(4);
    expect((await all()).filter((a) => a.esignRequestId).map((a) => a.esignRequestId).sort()).toEqual(sigs.map((a) => a.esignRequestId).sort());
  });

  it("a second offer for the same seller reuses the master agreement", async () => {
    await prepareAgreements(w.db, await w.acceptedOffer(), gw, T0);
    await prepareAgreements(w.db, await w.acceptedOffer(), gw, T0);
    expect((await all()).filter((a) => a.kind === "master")).toHaveLength(1);
    expect(await all()).toHaveLength(7);
  });

  it("only for accepted offers", async () => {
    await expect(prepareAgreements(w.db, "00000000-0000-0000-0000-000000000000", gw, T0)).rejects.toThrow(/not found/);
  });

  it("notice stays pending while the buyer has no login, and goes out on the next sweep", async () => {
    await w.db.delete(memberships).where(eq(memberships.userId, w.buyerUserId));
    await w.db.delete(users).where(eq(users.id, w.buyerUserId));
    const offer = await w.acceptedOffer();
    await prepareAgreements(w.db, offer, gw, T0);
    expect((await all()).find((a) => a.kind === "assignment_notice")!.status).toBe("pending");
    await w.db.insert(users).values({ name: "AP2", email: "ap2@big.com", role: "buyer", businessId: w.buyerId });
    expect(await prepareAllAccepted(w.db, gw)).toBe(1);
    expect((await all()).find((a) => a.kind === "assignment_notice")!.status).toBe("sent");
  });

  it("generates real PDFs, and user-controlled names are plain text, never markup", async () => {
    await w.db.update(businesses).set({ legalName: `<script>alert("x")</script> & Co` }).where(eq(businesses.id, w.sellerId));
    await prepareAgreements(w.db, await w.acceptedOffer(), gw, T0);
    const docs = await all();
    for (const kind of ["master", "invoice_schedule", "assignment_notice"]) {
      const d = docs.find((a) => a.kind === kind)!;
      expect(d.documentRef.endsWith(".pdf")).toBe(true);
      const { bytes, contentType } = await readDocument(d.documentRef);
      expect(contentType).toBe("application/pdf");
      expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
      expect(bytes.length).toBeGreaterThan(1500);
    }
    expect(docText(masterAgreement({ seller: { legalName: `<b>X</b> & Co`, gstin: null }, now: T0 }))).toContain("<b>X</b> & Co");
  });

  it("renders long documents across pages and keeps the rupee sign and odd characters from breaking the PDF", async () => {
    expect(pdfSafe("\u20B91,00,000.00 \u201Cquoted\u201D \u0928\u092E\u0938\u094D\u0924\u0947")).toBe('Rs. 1,00,000.00 "quoted" ??????');
    const long = { title: "Long", blocks: [{ h: "Long" }, ...Array.from({ length: 60 }, (_, i) => ({ p: [{ b: `Clause ${i + 1}. ` }, "This clause repeats to fill the page and force the layout to continue on the next page. ".repeat(4)] }))] };
    const pdf = await renderPdf(long);
    expect((await PDFDocument.load(pdf)).getPageCount()).toBeGreaterThan(1);
  });
});

describe("signing and the disbursement gate", () => {
  it("blocked until master + schedule are signed and the notice is sent", async () => {
    const offer = await w.acceptedOffer();
    await prepareAgreements(w.db, offer, gw, T0);
    expect(await readiness(w.db, offer)).toEqual({ master: false, schedule: false, notice: true, ready: false });
    await expect(assertReadyToDisburse(w.db, offer)).rejects.toThrow("AGREEMENTS_INCOMPLETE: master, schedule");

    expect(await signInApp(w.db, { offerId: offer, actor: { ...w.sellerActor, ip: "1.2.3.4", userAgent: "vitest" } }, T0)).toBe(2);
    await expect(assertReadyToDisburse(w.db, offer)).resolves.toBeUndefined();
    const signed = (await all()).find((a) => a.kind === "invoice_schedule")!;
    expect(signed).toMatchObject({ status: "signed", signedByEmail: "s@seller.com", signedIp: "1.2.3.4" });
    expect(signed.documentHash).toHaveLength(64); // what was signed is pinned by hash
  });

  it("a second offer needs only its own schedule signed (master is already executed)", async () => {
    const o1 = await w.acceptedOffer();
    await prepareAgreements(w.db, o1, gw, T0);
    await signInApp(w.db, { offerId: o1, actor: w.sellerActor }, T0);
    const o2 = await w.acceptedOffer();
    await prepareAgreements(w.db, o2, gw, T0);
    expect(await readiness(w.db, o2)).toEqual({ master: true, schedule: false, notice: true, ready: false });
    expect(await signInApp(w.db, { offerId: o2, actor: w.sellerActor }, T0)).toBe(1);
    expect((await readiness(w.db, o2)).ready).toBe(true);
  });

  it("only the offer's seller can sign, and only against the mock provider", async () => {
    const offer = await w.acceptedOffer();
    await prepareAgreements(w.db, offer, gw, T0);
    await expect(signInApp(w.db, { offerId: offer, actor: { ...w.sellerActor, businessId: w.buyerId } })).rejects.toThrow("FORBIDDEN");
    await expect(signInApp(w.db, { offerId: offer, actor: { ...w.sellerActor, role: "buyer" } })).rejects.toThrow("FORBIDDEN");
    process.env.INTEGRATIONS_MODE = "live";
    try { await expect(signInApp(w.db, { offerId: offer, actor: w.sellerActor })).rejects.toThrow(/mock/); }
    finally { delete process.env.INTEGRATIONS_MODE; }
  });

  it("completeSignature is idempotent; unknown requests and failures are handled", async () => {
    const offer = await w.acceptedOffer();
    await prepareAgreements(w.db, offer, gw, T0);
    const [a, b] = (await all()).filter((x) => x.esignRequestId);
    expect((await completeSignature(w.db, { requestId: a.esignRequestId!, outcome: "signed" }, T0)).already).toBe(false);
    expect((await completeSignature(w.db, { requestId: a.esignRequestId!, outcome: "signed" }, T0)).already).toBe(true);
    await expect(completeSignature(w.db, { requestId: "nope", outcome: "signed" })).rejects.toThrow(/unknown/);
    await completeSignature(w.db, { requestId: b.esignRequestId!, outcome: "failed" });
    expect((await w.db.select().from(agreements).where(eq(agreements.id, b.id)))[0].status).toBe("failed");
  });
});

describe("verifyWebhook", () => {
  const body = JSON.stringify({ requestId: "r1", status: "signed" });
  const sig = (s: string, secret = "shh") => createHmac("sha256", secret).update(s).digest("hex");
  it("accepts only a correct HMAC", () => {
    expect(verifyWebhook(body, sig(body), "shh")).toBe(true);
    expect(verifyWebhook(body + " ", sig(body), "shh")).toBe(false); // tampered body
    expect(verifyWebhook(body, sig(body, "other"), "shh")).toBe(false);
    expect(verifyWebhook(body, null, "shh")).toBe(false);
    expect(verifyWebhook(body, "zz", "shh")).toBe(false);
    expect(verifyWebhook(body, sig(body, ""), "")).toBe(false); // unset secret never validates
  });
});

describe("canViewDocument", () => {
  it("seller/buyer/staff access; buyers never see pricing documents", async () => {
    const offer = await w.acceptedOffer();
    await prepareAgreements(w.db, offer, gw, T0);
    const ref = (k: string) => (all().then((r) => r.find((a) => a.kind === k)!.documentRef));
    const seller = { role: "seller", businessId: w.sellerId }, buyer = { role: "buyer", businessId: w.buyerId };
    expect(await canViewDocument(w.db, seller, await ref("invoice_schedule"))).toBe(true);
    expect(await canViewDocument(w.db, buyer, await ref("assignment_notice"))).toBe(true);
    expect(await canViewDocument(w.db, buyer, await ref("invoice_schedule"))).toBe(false);
    expect(await canViewDocument(w.db, buyer, await ref("master"))).toBe(false);
    expect(await canViewDocument(w.db, { role: "seller", businessId: w.buyerId }, await ref("master"))).toBe(false);
    expect(await canViewDocument(w.db, { role: "ops", businessId: null }, await ref("master"))).toBe(true);
    expect(await canViewDocument(w.db, seller, "f".repeat(64) + ".html")).toBe(false);
    const [inv] = await w.db.select().from(invoices);
    await w.db.update(invoices).set({ documentRef: "a".repeat(64) + ".pdf" }).where(eq(invoices.id, inv.id));
    expect(await canViewDocument(w.db, buyer, "a".repeat(64) + ".pdf")).toBe(true);
  });
});
