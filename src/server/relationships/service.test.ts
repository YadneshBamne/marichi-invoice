import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "../testdb";
import { businesses, buyerSellerRelationships, users } from "../db/schema";
import { submitKyb, submitLightKyb } from "../kyb/service";
import { assertCanRaiseInvoice, linkBuyer } from "./service";
import type { Database } from "../db/client";

let db: Database;
beforeEach(async () => { db = await testDb(); });

const biz = async (legalName: string) =>
  (await db.insert(businesses).values({ legalName, entityType: "pvt_ltd" }).returning())[0].id;
const approvedSeller = async () => {
  const id = await biz("Seller Co");
  await submitKyb(db, {
    businessId: id, pan: "ABCDE1234F", ubos: [{ name: "Ravi", shareholdingBps: 10000 }],
    bank: { accountNumber: "123456789012", ifsc: "HDFC0001234", holderName: "Seller Co" },
  });
  return id;
};
const GSTIN = "27ABCDE1234F1Z5";
const reject = (p: Promise<unknown>, m: string) => expect(p).rejects.toThrow(m);

describe("buyer–seller relationships", () => {
  it("a buyer we have never seen becomes a pending buyer the supplier can invoice at once; it is verified by its contact's first confirmation", async () => {
    const seller = await approvedSeller();
    const r = await linkBuyer(db, { sellerId: seller, buyerGstin: GSTIN, buyerEmail: "ap@bigcorp.com", buyerName: "Big Corp" });
    expect(r).toMatchObject({ linked: true, pending: true });
    const [b] = await db.select().from(businesses).where(eq(businesses.gstin, GSTIN));
    expect(b).toMatchObject({ legalName: "Big Corp", kind: "buyer", kybLevel: "light", kybStatus: "submitted" });
    const rel = (await db.select().from(buyerSellerRelationships).where(eq(buyerSellerRelationships.sellerId, seller)))[0];
    expect(rel.contactEmail).toBe("ap@bigcorp.com");
    expect((await assertCanRaiseInvoice(db, seller, b.id)).creditTermsDays).toBe(60);
  });

  it("needs the buyer's name the first time, a real contact address, and a contact who is not the supplier's own people", async () => {
    const seller = await approvedSeller();
    await db.insert(users).values({ name: "Sam", email: "sam@sellerco.com", role: "seller", businessId: seller });
    await reject(linkBuyer(db, { sellerId: seller, buyerGstin: GSTIN, buyerEmail: "ap@bigcorp.com" }), "company name");
    await reject(linkBuyer(db, { sellerId: seller, buyerGstin: GSTIN, buyerEmail: "nope", buyerName: "Big Corp" }), "email address");
    await reject(linkBuyer(db, { sellerId: seller, buyerGstin: GSTIN, buyerEmail: "sam@sellerco.com", buyerName: "Big Corp" }), "not at your own company");
    await reject(linkBuyer(db, { sellerId: seller, buyerGstin: GSTIN, buyerEmail: "boss@sellerco.com", buyerName: "Big Corp" }), "not at your own company"); // same company domain
    await linkBuyer(db, { sellerId: seller, buyerGstin: GSTIN, buyerEmail: "someone@gmail.com", buyerName: "Big Corp" }); // a free mailbox is allowed
  });

  it("a name that hits sanctions screening is held and cannot be invoiced", async () => {
    const seller = await approvedSeller();
    const r = await linkBuyer(db, { sellerId: seller, buyerGstin: GSTIN, buyerEmail: "a@b.com", buyerName: "SANCTIONED Trading Ltd" });
    expect(r).toEqual({ linked: false, invited: true });
    const [b] = await db.select().from(businesses).where(eq(businesses.gstin, GSTIN));
    expect(b.kybStatus).toBe("under_review");
    await reject(assertCanRaiseInvoice(db, seller, b.id), "BUYER_NOT_VERIFIED");
    expect(await db.select().from(buyerSellerRelationships)).toHaveLength(0);
  });

  it("a buyer who signed up but has not been verified is invited and linked when it is approved", async () => {
    const seller = await approvedSeller();
    const buyer = await biz("Big Corp");
    await db.update(businesses).set({ gstin: GSTIN }).where(eq(businesses.id, buyer)); // registered itself, still a draft
    expect(await linkBuyer(db, { sellerId: seller, buyerGstin: GSTIN, buyerEmail: "ap@bigcorp.com" })).toEqual({ linked: false, invited: true });
    await reject(assertCanRaiseInvoice(db, seller, buyer), "BUYER_NOT_VERIFIED");
    await db.update(businesses).set({ gstin: null }).where(eq(businesses.id, buyer));
    expect((await submitLightKyb(db, { businessId: buyer, gstin: GSTIN, pan: "BCDEF2345G" })).status).toBe("approved");
    expect(await db.select().from(buyerSellerRelationships).where(eq(buyerSellerRelationships.sellerId, seller))).toHaveLength(1);
  });

  it("a GSTIN a supplier already named cannot be re-registered by someone else; they are pointed to the emailed link", async () => {
    const seller = await approvedSeller();
    await linkBuyer(db, { sellerId: seller, buyerGstin: GSTIN, buyerEmail: "ap@bigcorp.com", buyerName: "Big Corp" });
    const stranger = await biz("Big Corp Again");
    await reject(submitLightKyb(db, { businessId: stranger, gstin: GSTIN, pan: "BCDEF2345G" }), "already registered");
  });

  it("verified buyer links immediately; re-linking is idempotent", async () => {
    const seller = await approvedSeller();
    const buyer = await biz("Big Corp");
    await submitLightKyb(db, { businessId: buyer, gstin: GSTIN, pan: "BCDEF2345G" });
    const a = await linkBuyer(db, { sellerId: seller, buyerGstin: GSTIN, buyerEmail: "x@y.com" });
    expect(a.linked).toBe(true);
    await linkBuyer(db, { sellerId: seller, buyerGstin: GSTIN, buyerEmail: "x@y.com" });
    expect(await db.select().from(buyerSellerRelationships)).toHaveLength(1);
  });

  it("guards: unapproved seller, bad GSTIN, self-dealing", async () => {
    const draft = await biz("Draft Co");
    await reject(linkBuyer(db, { sellerId: draft, buyerGstin: GSTIN, buyerEmail: "a@b.c" }), "seller KYB not approved");
    const seller = await approvedSeller();
    await reject(linkBuyer(db, { sellerId: seller, buyerGstin: "nope", buyerEmail: "a@b.co" }), "invalid GSTIN");
    await reject(assertCanRaiseInvoice(db, seller, seller), "SELF_DEALING");
  });
});
