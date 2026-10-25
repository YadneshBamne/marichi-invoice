import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { extractText, getDocumentProxy } from "unpdf";
import { auditLog, financingOffers, invoiceCollections, invoices, legalNotices, notifications, users } from "../db/schema";
import { gw, T0, world } from "../testkit";
import { readDocument } from "../vault";
import { canViewDocument } from "../agreements/service";
import { COLLECTIONS } from "./waterfall";
import { handOver, issueLegalNotice, noticeNo, runLegalSweep } from "./legal";

let w: Awaited<ReturnType<typeof world>>;
const admin = { id: "00000000-0000-0000-0000-0000000000a9", role: "admin" };
const DAY = 86_400_000;
const at = (dpd: number) => new Date(Date.parse("2026-11-20T10:00:00Z") + dpd * DAY); // due date is 2026-11-20
beforeEach(async () => {
  w = await world();
  await w.db.insert(users).values({ id: admin.id, name: "Admin", email: "admin@marichi.test", role: "admin" });
});
const mails = async (template: string) => (await w.db.select().from(notifications)).filter((n) => n.template === template);
const pdfText = async (ref: string) => (await extractText(await getDocumentProxy(new Uint8Array((await readDocument(ref)).bytes)), { mergePages: true })).text;

describe("issuing a legal notice", () => {
  it("states what is owing today, gives a date to pay by, is kept as a PDF, and tells the buyer", async () => {
    const f = await w.financed();
    const n = await issueLegalNotice(w.db, admin, { invoiceId: f.invoiceId, addressee: "buyer" }, gw, at(50));
    const [col] = await w.db.select().from(invoiceCollections).where(eq(invoiceCollections.invoiceId, f.invoiceId));
    expect(n).toMatchObject({ status: "issued", addressee: "buyer", addresseeId: w.buyerId, dpd: 50, cureBy: "2027-01-24" });
    expect(n.amountDue).toBeGreaterThan(col.principal); // discount and penal have accrued since the last sweep
    const text = await pdfText(n.documentRef);
    for (const s of [noticeNo(n.seq), "Demand Notice for Overdue Payment", "Big Corp", "INV-1", f.account, "within 15 days", "Penal charges"]) expect(text).toContain(s);
    const [mail] = await mails("legal_notice");
    expect(mail.body).toContain(noticeNo(n.seq));
    expect(mail.body).toContain(`/api/documents/${n.documentRef}`);
    expect((await w.db.select().from(auditLog).where(eq(auditLog.action, "legal_notice.issue"))).length).toBe(1);
  });

  it("is for admin or compliance only, and only once the invoice is far enough past due", async () => {
    const f = await w.financed();
    await expect(issueLegalNotice(w.db, { id: admin.id, role: "ops" }, { invoiceId: f.invoiceId, addressee: "buyer" }, gw, at(50))).rejects.toThrow(/forbidden/);
    await expect(issueLegalNotice(w.db, admin, { invoiceId: f.invoiceId, addressee: "buyer" }, gw, at(COLLECTIONS.legalNoticeAfterDpd - 1))).rejects.toThrow(/can be issued from 45 days past due; this invoice is 44/);
    await expect(issueLegalNotice(w.db, admin, { invoiceId: f.invoiceId, addressee: "lender" }, gw, at(50))).rejects.toThrow(/choose who/);
    await expect(issueLegalNotice(w.db, { id: admin.id, role: "compliance" }, { invoiceId: f.invoiceId, addressee: "buyer" }, gw, at(COLLECTIONS.legalNoticeAfterDpd))).resolves.toBeTruthy();
  });

  it("one open notice per party; the seller is asked only where there is recourse; nothing once paid", async () => {
    const f = await w.financed();
    await issueLegalNotice(w.db, admin, { invoiceId: f.invoiceId, addressee: "buyer" }, gw, at(50));
    await expect(issueLegalNotice(w.db, admin, { invoiceId: f.invoiceId, addressee: "buyer" }, gw, at(51))).rejects.toThrow(/already open/);
    await w.db.update(financingOffers).set({ recourse: false }).where(eq(financingOffers.id, f.offer));
    await expect(issueLegalNotice(w.db, admin, { invoiceId: f.invoiceId, addressee: "seller" }, gw, at(50))).rejects.toThrow(/without recourse/);
    await w.db.update(financingOffers).set({ recourse: true }).where(eq(financingOffers.id, f.offer));
    const s = await issueLegalNotice(w.db, admin, { invoiceId: f.invoiceId, addressee: "seller" }, gw, at(50));
    expect(await pdfText(s.documentRef)).toContain("recourse term of your agreement");
    expect(s.addresseeId).toBe(w.sellerId);
    await w.db.update(invoiceCollections).set({ closedAt: at(52) }).where(eq(invoiceCollections.invoiceId, f.invoiceId));
    const g = await w.financed();
    await w.db.update(invoiceCollections).set({ closedAt: at(1) }).where(eq(invoiceCollections.invoiceId, g.invoiceId));
    await expect(issueLegalNotice(w.db, admin, { invoiceId: g.invoiceId, addressee: "buyer" }, gw, at(50))).rejects.toThrow(/nothing is outstanding/);
  });

  it("can be opened by the company it is addressed to and by staff, and no one else", async () => {
    const f = await w.financed();
    const n = await issueLegalNotice(w.db, admin, { invoiceId: f.invoiceId, addressee: "buyer" }, gw, at(50));
    expect(await canViewDocument(w.db, { role: "buyer", businessId: w.buyerId }, n.documentRef)).toBe(true);
    expect(await canViewDocument(w.db, { role: "ops", businessId: null }, n.documentRef)).toBe(true);
    expect(await canViewDocument(w.db, { role: "seller", businessId: w.sellerId }, n.documentRef)).toBe(false);
  });
});

describe("handing over for recovery", () => {
  it("only after the notice period, with a named agency, once; the addressee is told", async () => {
    const f = await w.financed();
    const n = await issueLegalNotice(w.db, admin, { invoiceId: f.invoiceId, addressee: "buyer" }, gw, at(50));
    await expect(handOver(w.db, admin, n.id, { agency: "Recover & Co" }, gw, at(60))).rejects.toThrow(/runs until 2027-01-24/);
    await expect(handOver(w.db, admin, n.id, { agency: "  " }, gw, at(70))).rejects.toThrow(/name the agency/);
    await expect(handOver(w.db, { id: admin.id, role: "ops" }, n.id, { agency: "Recover & Co" }, gw, at(70))).rejects.toThrow(/forbidden/);
    const done = await handOver(w.db, admin, n.id, { agency: "Recover & Co", note: "Sent file by courier" }, gw, at(70));
    expect(done).toMatchObject({ status: "handed_over", agency: "Recover & Co", handedOverBy: admin.id });
    expect((await mails("recovery_handoff"))[0].body).toContain("Recover & Co");
    await expect(handOver(w.db, admin, n.id, { agency: "Another" }, gw, at(71))).rejects.toThrow(/not waiting/);
  });
});

describe("the daily sweep", () => {
  it("tells staff once when a notice can be issued and once when its period has lapsed", async () => {
    const f = await w.financed();
    await w.db.update(invoices).set({ status: "overdue" }).where(eq(invoices.id, f.invoiceId));
    expect(await runLegalSweep(w.db, gw, at(30))).toEqual({ closed: 0, due: 0, lapsed: 0 });
    expect(await runLegalSweep(w.db, gw, at(46))).toEqual({ closed: 0, due: 1, lapsed: 0 });
    expect(await runLegalSweep(w.db, gw, at(47))).toEqual({ closed: 0, due: 0, lapsed: 0 }); // already told
    expect((await mails("legal_notice_due")).length).toBe(1);
    const n = await issueLegalNotice(w.db, admin, { invoiceId: f.invoiceId, addressee: "buyer" }, gw, at(46));
    expect(await runLegalSweep(w.db, gw, at(50))).toEqual({ closed: 0, due: 0, lapsed: 0 }); // inside the period
    expect(await runLegalSweep(w.db, gw, at(62))).toEqual({ closed: 0, due: 0, lapsed: 1 });
    expect(await runLegalSweep(w.db, gw, at(63))).toEqual({ closed: 0, due: 0, lapsed: 0 });
    expect((await mails("legal_cure_lapsed")).length).toBe(1);
    void n;
  });

  it("closes a notice when the invoice is paid, and one that was not handed over when it is written off", async () => {
    const f = await w.financed(), g = await w.financed();
    const a = await issueLegalNotice(w.db, admin, { invoiceId: f.invoiceId, addressee: "buyer" }, gw, at(50));
    const b = await issueLegalNotice(w.db, admin, { invoiceId: g.invoiceId, addressee: "buyer" }, gw, at(50));
    await w.db.update(invoices).set({ status: "paid" }).where(eq(invoices.id, f.invoiceId));
    await w.db.update(invoices).set({ status: "written_off" }).where(eq(invoices.id, g.invoiceId));
    expect(await runLegalSweep(w.db, gw, at(60))).toMatchObject({ closed: 2 });
    const status = async (id: string) => (await w.db.select().from(legalNotices).where(eq(legalNotices.id, id)))[0].status;
    expect(await status(a.id)).toBe("cured");
    expect(await status(b.id)).toBe("closed");
  });
});
