import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "../testdb";
import { businesses, fraudCases, invoices } from "../db/schema";
import { submitKyb, submitLightKyb } from "../kyb/service";
import { linkBuyer } from "../relationships/service";
import { mock } from "../integrations/mock";
import type { IrnClaim } from "../integrations/gateway";
import { checkBasics, createInvoice, revalidatePendingIrns, type NewInvoice } from "./service";
import { formatINR, rupeesToPaise } from "../../lib/money";
import type { Database } from "../db/client";

const NOW = new Date("2026-10-06T00:00:00Z");
const SELLER_GSTIN = "27AAAAA1111A1Z5";
const BUYER_GSTIN = "29BBBBB2222B1Z5";
let db: Database;
let sellerId: string, buyerId: string;

beforeEach(async () => {
  db = await testDb();
  sellerId = (await db.insert(businesses).values({ legalName: "Seller Co", entityType: "pvt_ltd" }).returning())[0].id;
  buyerId = (await db.insert(businesses).values({ legalName: "Big Corp", entityType: "pvt_ltd" }).returning())[0].id;
  await submitKyb(db, {
    businessId: sellerId, pan: "ABCDE1234F", gstin: SELLER_GSTIN, ubos: [{ name: "Ravi", shareholdingBps: 10000 }],
    bank: { accountNumber: "123456789012", ifsc: "HDFC0001234", holderName: "Seller Co" },
  });
  await submitLightKyb(db, { businessId: buyerId, gstin: BUYER_GSTIN, pan: "BCDEF2345G" });
  await linkBuyer(db, { sellerId, buyerGstin: BUYER_GSTIN, buyerEmail: "ap@bigcorp.com" });
});

let n = 0;
const inv = (over: Partial<NewInvoice> = {}): NewInvoice => ({
  sellerId, buyerId, invoiceNumber: `INV-${++n}`, invoiceDate: "2026-09-20", dueDate: "2026-11-20",
  amount: 5_00_000_00n, contentHash: `hash-${n}`, ...over,
});
const make = (o?: Partial<NewInvoice>, gw = mock) => createInvoice(db, inv(o), gw, NOW);

describe("rules", () => {
  it("checkBasics", () => {
    const ok = { invoiceDate: "2026-09-20", dueDate: "2026-11-20", amount: 5_00_000_00n };
    expect(checkBasics(ok, NOW)).toBeNull();
    expect(checkBasics({ ...ok, invoiceDate: "2026-06-01" }, NOW)).toMatch(/older than 90/);
    expect(checkBasics({ ...ok, dueDate: "2026-10-01" }, NOW)).toMatch(/past its due/);
    expect(checkBasics({ ...ok, dueDate: "2026-09-19" }, NOW)).toMatch(/after invoice date/);
    expect(checkBasics({ ...ok, invoiceDate: "2026-10-07" }, NOW)).toMatch(/future/);
    expect(checkBasics({ ...ok, amount: 100n }, NOW)).toMatch(/ticket/);
  });
  it("money helpers", () => {
    expect(rupeesToPaise("1,234.5")).toBe(123450n);
    expect(rupeesToPaise("10")).toBe(1000n);
    expect(() => rupeesToPaise("1.234")).toThrow();
    expect(formatINR(123456789n)).toBe("₹12,34,567.89");
    expect(formatINR(99905n)).toBe("₹999.05");
  });
});

describe("createInvoice", () => {
  it("no IRN -> validated, flagged absent", async () => {
    expect(await make()).toMatchObject({ status: "validated", irnStatus: "absent" });
  });

  it("matching IRN -> validated/verified", async () => {
    expect(await make({ irn: "IRN-OK-1" })).toMatchObject({ status: "validated", irnStatus: "verified" });
  });

  it("IRN mismatch -> held with a fraud case; not-found and cancelled are rejected", async () => {
    const r = await make({ irn: "MISMATCH-1" });
    expect(r).toMatchObject({ status: "uploaded", irnStatus: "mismatch" });
    expect(await db.select().from(fraudCases).where(eq(fraudCases.entityId, r.id))).toHaveLength(1);
    await expect(make({ irn: "NOTFOUND-1" })).rejects.toThrow("IRN_NOT_FOUND");
    await expect(make({ irn: "CANCEL-1" })).rejects.toThrow("IRN_CANCELLED");
  });

  it("IRP outage parks the invoice; the worker validates it once the IRP is back", async () => {
    const r = await make({ irn: "DOWN-1" });
    expect(r).toMatchObject({ status: "uploaded", irnStatus: "pending" });
    expect(await revalidatePendingIrns(db, mock)).toBe(0); // still down
    // IRP recovers: same invoice, registry now answers (hint-echo => verified)
    const recovered = { ...mock, irn: { getIrn: async (_: string, h?: IrnClaim) => ({ ...h!, cancelled: false }) } };
    await db.update(invoices).set({ irn: "OK-AFTER" }).where(eq(invoices.id, r.id));
    expect(await revalidatePendingIrns(db, recovered)).toBe(1);
    const [row] = await db.select().from(invoices).where(eq(invoices.id, r.id));
    expect(row).toMatchObject({ status: "validated", irnStatus: "verified" });
  });

  it("rejects duplicates by file hash, IRN and seller+number", async () => {
    await make({ irn: "IRN-DUP", invoiceNumber: "A-1", contentHash: "same" });
    await expect(make({ contentHash: "same" })).rejects.toThrow("DUPLICATE_INVOICE");
    await expect(make({ irn: "IRN-DUP" })).rejects.toThrow("DUPLICATE_INVOICE");
    await expect(make({ invoiceNumber: "A-1" })).rejects.toThrow("DUPLICATE_INVOICE");
    expect(await db.select().from(invoices)).toHaveLength(1);
  });

  it("another seller re-using a financed IRN opens a fraud case", async () => {
    const first = await make({ irn: "IRN-STOLEN" });
    const s2 = (await db.insert(businesses).values({ legalName: "Seller Two", entityType: "pvt_ltd" }).returning())[0].id;
    await submitKyb(db, {
      businessId: s2, pan: "ABCDE1234F", gstin: "07CCCCC3333C1Z5", ubos: [{ name: "Sam", shareholdingBps: 10000 }],
      bank: { accountNumber: "999999999999", ifsc: "HDFC0001234", holderName: "Seller Two" },
    });
    await linkBuyer(db, { sellerId: s2, buyerGstin: BUYER_GSTIN, buyerEmail: "ap@bigcorp.com" });
    await expect(createInvoice(db, inv({ sellerId: s2, irn: "IRN-STOLEN" }), mock, NOW)).rejects.toThrow("DUPLICATE_INVOICE");
    const cases = await db.select().from(fraudCases).where(eq(fraudCases.entityId, first.id));
    expect(cases.map((c) => c.ruleTriggered)).toEqual(["duplicate_across_sellers"]);
  });

  it("blocks invoices against an unlinked or unverified buyer", async () => {
    const stranger = (await db.insert(businesses).values({ legalName: "Stranger", entityType: "pvt_ltd" }).returning())[0].id;
    await expect(make({ buyerId: stranger })).rejects.toThrow("BUYER_NOT_VERIFIED");
  });
});
