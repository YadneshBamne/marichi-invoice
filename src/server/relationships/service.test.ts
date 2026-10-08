import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "../testdb";
import { businesses, buyerSellerRelationships } from "../db/schema";
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
  it("unverified buyer -> invite; auto-links when buyer completes light KYB", async () => {
    const seller = await approvedSeller();
    const buyer = await biz("Big Corp");
    expect(await linkBuyer(db, { sellerId: seller, buyerGstin: GSTIN, buyerEmail: "ap@bigcorp.com" }))
      .toEqual({ linked: false, invited: true });
    await reject(assertCanRaiseInvoice(db, seller, buyer), "BUYER_NOT_VERIFIED");

    expect((await submitLightKyb(db, { businessId: buyer, gstin: GSTIN, pan: "BCDEF2345G" })).status).toBe("approved");
    const rels = await db.select().from(buyerSellerRelationships).where(eq(buyerSellerRelationships.sellerId, seller));
    expect(rels).toHaveLength(1);
    expect((await assertCanRaiseInvoice(db, seller, buyer)).creditTermsDays).toBe(60);
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

  it("guards: unapproved seller, bad GSTIN, self-dealing, sanctioned buyer", async () => {
    const draft = await biz("Draft Co");
    await reject(linkBuyer(db, { sellerId: draft, buyerGstin: GSTIN, buyerEmail: "a@b.c" }), "seller KYB not approved");
    const seller = await approvedSeller();
    await reject(linkBuyer(db, { sellerId: seller, buyerGstin: "nope", buyerEmail: "a@b.c" }), "invalid GSTIN");
    await reject(assertCanRaiseInvoice(db, seller, seller), "SELF_DEALING");

    const bad = await biz("SANCTIONED Buyer Ltd");
    expect((await submitLightKyb(db, { businessId: bad, gstin: GSTIN, pan: "BCDEF2345G" })).status).toBe("under_review");
    await linkBuyer(db, { sellerId: seller, buyerGstin: GSTIN, buyerEmail: "a@b.c" });
    await reject(assertCanRaiseInvoice(db, seller, bad), "BUYER_NOT_VERIFIED");
    expect(await db.select().from(buyerSellerRelationships)).toHaveLength(0);
  });
});
