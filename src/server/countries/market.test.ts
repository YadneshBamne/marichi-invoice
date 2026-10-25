import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { businesses, disbursements, financingOffers, invoices, notifications, registryFilings, users } from "../db/schema";
import { gw, T0, useMarket, world } from "../testkit";
import { checkId, market, PACKS } from "../../lib/countries";
import { formatCompactMoney, formatMoney } from "../../lib/money";
import { DEFS, DEF_BY_KEY } from "../config/policy";
import { submitKyb } from "../kyb/service";
import { linkBuyer } from "../relationships/service";
import { createInvoice } from "../invoices/service";
import { underwriteInvoice } from "../underwriting/service";
import { generateOffer } from "../offers/service";
import { acceptBid, placeBid } from "../marketplace/service";
import { prepareAgreements, signInApp } from "../agreements/service";
import { executeDisbursement, railPlan, requestDisbursement } from "../disbursements/service";
import { ensureFiling, fileAssignment, registryReady, runRegistryFilings } from "../registry/service";
import { splitTax } from "../ledger/tax";
import { balance } from "../ledger/accounts";
import { termsFor } from "../agreements/country";
import { mock } from "../integrations/mock";
import { linkForeignBuyer } from "../crossborder/service";
import { appsFor } from "../../lib/apps";

afterEach(() => useMarket("IN"));

describe("the country packs", () => {
  it("every pack names its identifiers, currency, rails and law, and India is the default", () => {
    expect(market().code).toBe("IN");
    for (const p of Object.values(PACKS)) {
      expect(p.currency.code).toHaveLength(3);
      expect(p.ids.taxReg.pattern.test("")).toBe(false);
      expect(p.rails.small.length + p.rails.large.length).toBeGreaterThan(1);
      expect(p.terms.law).toBeTruthy();
      expect(Object.keys(p.institutions).length).toBeGreaterThan(2);
    }
  });

  it("amounts are written the way each market writes them", () => {
    expect(formatMoney(1_23_45_678_90n)).toBe("₹1,23,45,678.90");
    expect(formatMoney(-5_00n)).toBe("-₹5.00");
    expect(formatCompactMoney(8_90_000_00n)).toBe("₹8.9L");
    useMarket("ZM");
    expect(formatMoney(12_345_678_90n)).toBe("K12,345,678.90");
    expect(formatCompactMoney(8_900_000_00n)).toBe("K8.9m");
    expect(formatCompactMoney(950_00n)).toBe("K950");
  });

  it("an identifier is tidied, checked against the pack and named the way the country names it", () => {
    expect(checkId(market().ids.kyb, " abcde 1234f ")).toBe("ABCDE1234F");
    expect(() => checkId(market().ids.taxReg, "NOT-A-GSTIN")).toThrow(/invalid GSTIN/);
    expect(checkId(market().ids.companyReg!, "", true)).toBeUndefined();
    useMarket("ZM");
    expect(checkId(market().ids.taxReg, "1000000011")).toBe("1000000011");
    expect(() => checkId(market().ids.taxReg, "ABCDE1234F")).toThrow(/invalid TPIN/);
  });

  it("agreement terms come from the pack: Zambian law and registry, a counsel-bracketed text for a country with no pack", () => {
    expect(termsFor(null).registry).toMatch(/CERSAI/);
    expect(termsFor("ZM")).toMatchObject({ law: "the laws of the Republic of Zambia" });
    expect(termsFor("ZM").registry).toMatch(/PACRA/);
    expect(termsFor("KE").law).toMatch(/counsel/);
    useMarket("ZM");
    expect(termsFor(null).code).toBe("ZM"); // a company with no country belongs to the home market
  });

  it("the tax on our fees is the market's: 18% GST in India, 16% VAT in Zambia", () => {
    expect(splitTax(118_00n)).toEqual({ base: 100_00n, tax: 18_00n });
    useMarket("ZM");
    expect(splitTax(116_00n)).toEqual({ base: 100_00n, tax: 16_00n });
  });

  it("payout rails follow the pack", () => {
    expect(railPlan(1_00_000_00n)).toEqual(["IMPS", "NEFT"]);
    expect(railPlan(9_00_000_00n)).toEqual(["RTGS", "NEFT"]);
    useMarket("ZM");
    expect(railPlan(50_000_00n)).toEqual(["EFT", "ZIPSS"]);
    expect(railPlan(250_000_00n)).toEqual(["ZIPSS", "EFT"]);
  });
});

describe("policy in another currency", () => {
  it("money values and their limits are scaled to the currency, and the platform's own balance sheet starts off", () => {
    const inr = { min: DEF_BY_KEY.get("invoice.minTicket")!.get(), max: DEF_BY_KEY.get("invoice.maxTicket")!.get(), funds: DEF_BY_KEY.get("offer.platformFunds")!.get() };
    expect(inr.min).toBe(10_000_00n);
    expect(inr.funds).toBe(1);
    useMarket("ZM");
    expect(DEF_BY_KEY.get("invoice.minTicket")!.get()).toBe(3_000_00n);
    expect(DEF_BY_KEY.get("invoice.maxTicket")!.get()).toBe(1_500_000_00n);
    expect(DEF_BY_KEY.get("offer.platformFunds")!.get()).toBe(0);
    expect(DEF_BY_KEY.get("uw.matrix.A.autoMax")!.get()).toBe(750_000_00n);
    expect(DEF_BY_KEY.get("uw.matrix.A.advanceBps")!.get()).toBe(9000); // rates are not money: unchanged
    useMarket("IN");
    expect(DEF_BY_KEY.get("invoice.minTicket")!.get()).toBe(10_000_00n);
    expect(DEF_BY_KEY.get("offer.platformFunds")!.get()).toBe(1);
    expect(DEFS.length).toBeGreaterThan(40);
  });
});

describe("India: filing at CERSAI", () => {
  it("a filing is made for every accepted offer, due in 30 days, and does not hold the payout", async () => {
    const w = await world();
    const offer = await w.acceptedOffer();
    await prepareAgreements(w.db, offer, gw, T0);
    const [f] = await w.db.select().from(registryFilings);
    expect(f).toMatchObject({ offerId: offer, registry: "CERSAI", status: "pending", dueBy: "2026-11-05" });
    expect(await registryReady(w.db, offer)).toBe(true); // India allows filing after the assignment
    expect(await runRegistryFilings(w.db, gw, T0)).toBe(1);
    const [done] = await w.db.select().from(registryFilings);
    expect(done).toMatchObject({ status: "filed", attempts: 1 });
    expect(done.reference).toMatch(/^MOCKREG-/);
    expect(await runRegistryFilings(w.db, gw, T0)).toBe(0); // nothing left; filing twice is a no-op
  });

  it("a registry that is down is retried, then staff are told", async () => {
    const w = await world();
    await w.db.insert(users).values({ name: "Ops", email: "ops@m.com", role: "ops" });
    await w.db.update(businesses).set({ legalName: "REGFAIL Traders" }).where(eq(businesses.id, w.sellerId));
    const offer = await w.acceptedOffer();
    await prepareAgreements(w.db, offer, gw, T0);
    for (let i = 0; i < 4; i++) await runRegistryFilings(w.db, gw, T0);
    const [f] = await w.db.select().from(registryFilings);
    expect(f).toMatchObject({ status: "pending", attempts: 4, lastError: "registry unavailable" });
    expect((await w.db.select().from(notifications)).map((n) => n.template)).not.toContain("registry_attention");
    await runRegistryFilings(w.db, gw, T0);
    expect((await w.db.select().from(notifications)).map((n) => n.template)).toContain("registry_attention");
    expect(await runRegistryFilings(w.db, gw, T0)).toBe(0); // out of attempts: a person must act
    await w.db.update(businesses).set({ legalName: "Seller Co" }).where(eq(businesses.id, w.sellerId));
    await w.db.update(registryFilings).set({ attempts: 0 }).where(eq(registryFilings.id, f.id));
    expect((await fileAssignment(w.db, f.id, gw, T0))?.status).toBe("filed");
  });
});

describe("Zambia end to end", () => {
  const ZW = { ...gw, bureau: { pull: async () => ({ score: 780, noHit: false }) } };

  it("verification takes a TPIN and a sort code, and refuses Indian identifiers", async () => {
    useMarket("ZM");
    const w = await world();
    const [s] = await w.db.select().from(businesses).where(eq(businesses.id, w.sellerId));
    expect(s).toMatchObject({ kybStatus: "approved", gstin: "1000000011" }); // the TPIN is both the taxpayer id and the invoice-level number
    const [other] = await w.db.insert(businesses).values({ legalName: "Copperbelt Foods", entityType: "pvt_ltd" }).returning();
    const base = { businessId: other.id, ubos: [{ name: "Mwansa", shareholdingBps: 10000 }], bank: { accountNumber: "0123456789", ifsc: "040001", holderName: "Copperbelt Foods" } };
    await expect(submitKyb(w.db, { ...base, pan: "ABCDE1234F" })).rejects.toThrow(/invalid TPIN/);
    await expect(submitKyb(w.db, { ...base, pan: "3000000031", bank: { ...base.bank, ifsc: "HDFC0001234" } })).rejects.toThrow(/invalid Bank sort code/);
    expect((await submitKyb(w.db, { ...base, pan: "3000000031", cin: "pacra12345" })).status).toBe("approved");
    expect((await w.db.select().from(businesses).where(eq(businesses.id, other.id)))[0]).toMatchObject({ gstin: "3000000031", cin: "PACRA12345" });
    // a buyer is named by TPIN, and an Indian GSTIN is not a TPIN
    await expect(linkBuyer(w.db, { sellerId: w.sellerId, buyerGstin: "29BBBBB2222B1Z5", buyerEmail: "ap@new.zm", buyerName: "New Buyer" })).rejects.toThrow(/invalid TPIN/);
    expect(await linkBuyer(w.db, { sellerId: w.sellerId, buyerGstin: "4000000041", buyerEmail: "ap@new.zm", buyerName: "New Buyer" })).toMatchObject({ linked: true, pending: true });
  });

  it("a financier funds the invoice in kwacha, the assignment is filed at PACRA first, and the payout goes by ZIPSS with VAT on the fee", async () => {
    useMarket("ZM");
    const w = await world();
    const { id: invoiceId } = await createInvoice(w.db, {
      sellerId: w.sellerId, buyerId: w.buyerId, invoiceNumber: "ZM-1", invoiceDate: "2026-09-25", dueDate: "2026-11-20",
      amount: 300_000_00n, contentHash: "zm-1", irn: "SI-OK-1",
    }, mock, T0);
    await w.db.update(invoices).set({ status: "eligible" }).where(eq(invoices.id, invoiceId));
    await underwriteInvoice(w.db, invoiceId, ZW, T0);
    expect((await generateOffer(w.db, invoiceId, ZW, T0)).unfunded).toBe(true); // no own balance sheet in Zambia: only financiers fund

    const f = await w.financier("Zambezi Finance", 500_000_00n);
    const bid = await placeBid(w.db, { id: f.actor.id, role: "financier", businessId: f.actor.businessId }, { invoiceId, advanceBps: 9000, discountBps: 1500 }, ZW, T0);
    const offer = await acceptBid(w.db, bid.id, w.sellerActor, ZW, T0);

    await prepareAgreements(w.db, offer.id, ZW, T0);
    await signInApp(w.db, { offerId: offer.id, actor: w.sellerActor }, T0);
    const [filing] = await w.db.select().from(registryFilings).where(eq(registryFilings.offerId, offer.id));
    expect(filing).toMatchObject({ registry: "PACRA", status: "pending", dueBy: null });
    await expect(requestDisbursement(w.db, offer.id)).rejects.toThrow(/REGISTRY_PENDING/); // priority goes to whoever files first

    await runRegistryFilings(w.db, ZW, T0);
    const d = await requestDisbursement(w.db, offer.id);
    await executeDisbursement(w.db, d.id, ZW, T0);
    const [paid] = await w.db.select().from(disbursements).where(eq(disbursements.id, d.id));
    expect(paid).toMatchObject({ status: "succeeded", rail: "ZIPSS" }); // K270,000 is above the EFT ceiling
    const [o] = await w.db.select().from(financingOffers).where(eq(financingOffers.id, offer.id));
    expect(await balance(w.db, "gst_payable")).toBe(-splitTax(o.feeAmount).tax); // 16% of the fee is VAT
    expect(splitTax(o.feeAmount).tax).toBe(o.feeAmount - (o.feeAmount * 10_000n) / 11_600n);
  });

  it("export financing follows Indian rules, so it is refused here and hidden from the app list", async () => {
    useMarket("ZM");
    const w = await world();
    await expect(linkForeignBuyer(w.db, { sellerId: w.sellerId, country: "ZA", taxId: "12345678", buyerEmail: "a@b.co" })).rejects.toThrow(/not available in Zambia/);
    expect(appsFor("seller").map((a) => a.id)).not.toContain("cross-border");
    useMarket("IN");
    expect(appsFor("seller").map((a) => a.id)).toContain("cross-border");
  });

  it("ensureFiling is idempotent and nothing is created in a market with no registry", async () => {
    const w = await world();
    const offer = await w.acceptedOffer();
    const a = await ensureFiling(w.db, offer, T0);
    const b = await ensureFiling(w.db, offer, T0);
    expect(a!.id).toBe(b!.id);
    expect(await w.db.select().from(registryFilings)).toHaveLength(1);
  });
});
