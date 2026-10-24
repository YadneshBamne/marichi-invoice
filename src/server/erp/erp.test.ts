import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { apiKeys, invoices, webhookDeliveries } from "../db/schema";
import { gw, T0, world } from "../testkit";
import { applyPayment } from "../collections/waterfall";
import { recordIncomingPayment } from "../collections/service";
import { createApiKey, authenticateKey, listApiKeys, revokeApiKey } from "./keys";
import { checkUrl, createEndpoint, deliverWebhooks, emitEvent, MAX_ATTEMPTS, setEndpointActive, sign } from "./events";
import { ApiError, createSellerInvoice, listInvoices } from "./invoices";
import { importInvoices, isoDate, parseCsv } from "./csv";

let w: Awaited<ReturnType<typeof world>>;
let owner: { id: string; role: string; orgRole: string; businessId: string | null };
beforeEach(async () => { w = await world(); owner = { id: w.sellerActor.id, role: "seller", orgRole: "owner", businessId: w.sellerId }; void applyPayment; });
const BUYER_GSTIN = "29BBBBB2222B1Z5"; // the buyer linked by the test world
const input = (n: string, over = {}) => ({ buyerGstin: BUYER_GSTIN, invoiceNumber: n, invoiceDate: "2026-09-25", dueDate: "2026-11-20", amount: "118000.00", ...over });

describe("API keys", () => {
  it("shows the key once, stores only its hash, authenticates it, and stops working when revoked", async () => {
    const { id, key } = await createApiKey(w.db, owner, "Tally sync");
    expect(key.startsWith("mk_live_")).toBe(true);
    const [row] = await w.db.select().from(apiKeys).where(eq(apiKeys.id, id));
    expect(row.keyHash).not.toContain(key); expect(JSON.stringify(row)).not.toContain(key);
    expect(await authenticateKey(w.db, key)).toMatchObject({ businessId: w.sellerId, kind: "seller" });
    expect(await authenticateKey(w.db, key + "x")).toBeNull();
    expect(await authenticateKey(w.db, null)).toBeNull();
    expect((await listApiKeys(w.db, w.sellerId))[0]).toMatchObject({ name: "Tally sync", revokedAt: null });
    await revokeApiKey(w.db, owner, id);
    expect(await authenticateKey(w.db, key)).toBeNull();
    await expect(revokeApiKey(w.db, owner, id)).rejects.toThrow(/already revoked/);
  });
  it("only an owner can create or revoke keys, and keys belong to one company", async () => {
    await expect(createApiKey(w.db, { ...owner, orgRole: "approver" }, "x key")).rejects.toThrow(/not allowed/);
    const { id } = await createApiKey(w.db, owner, "Mine");
    await expect(revokeApiKey(w.db, { ...owner, businessId: w.buyerId }, id)).rejects.toThrow(/not found/);
  });
});

describe("webhook addresses", () => {
  it("require https and refuse private networks and credentials", () => {
    expect(checkUrl("https://erp.example.com/hook", true)).toBe("https://erp.example.com/hook");
    expect(checkUrl("https://fcbarcelona.com/h", true)).toContain("fcbarcelona.com"); // looks like an IPv6 prefix but is a real hostname
    expect(() => checkUrl("http://erp.example.com/hook", true)).toThrow(/https/);
    expect(() => checkUrl("https://127.0.0.1/h", true)).toThrow(/private/);
    expect(() => checkUrl("https://10.1.2.3/h", true)).toThrow(/private/);
    expect(() => checkUrl("https://192.168.0.5/h", true)).toThrow(/private/);
    expect(() => checkUrl("https://169.254.169.254/latest", true)).toThrow(/private/);
    expect(() => checkUrl("https://[::1]/h", true)).toThrow(/private/);
    expect(() => checkUrl("https://intranet.local/h", true)).toThrow(/private/);
    expect(() => checkUrl("https://user:pw@erp.example.com/h", true)).toThrow(/username/);
    expect(() => checkUrl("not a url", true)).toThrow(/web address/);
    expect(checkUrl("http://localhost:4000/h", false)).toContain("localhost"); // for local testing only
    expect(() => checkUrl("http://localhost:4000/h", true)).toThrow();
  });
});

describe("webhook delivery", () => {
  const ok = () => vi.fn(async () => new Response("ok", { status: 200 })) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
  const setup = async (events: string[] = []) => (await createEndpoint(w.db, owner, { url: "http://localhost:4000/hook", events }));

  it("signs each delivery so the receiver can verify it, and marks it delivered", async () => {
    const ep = await setup();
    expect(await emitEvent(w.db, w.sellerId, "invoice.paid", { invoiceNumber: "X-1" }, T0)).toBe(1);
    const send = ok();
    expect(await deliverWebhooks(w.db, T0, send)).toEqual({ delivered: 1, retrying: 0, failed: 0 });
    const [url, init] = (send as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    const body = init.body as string;
    const sig = (init.headers as Record<string, string>)["x-marichi-signature"];
    const t = Number(sig.match(/t=(\d+)/)![1]);
    expect(url).toBe("http://localhost:4000/hook");
    expect(sig).toBe(`t=${t},v1=${createHmac("sha256", ep.secret).update(`${t}.${body}`).digest("hex")}`);
    expect(sign(ep.secret, body, t)).toBe(sig);
    expect(JSON.parse(body)).toMatchObject({ type: "invoice.paid", data: { invoiceNumber: "X-1" } });
    expect((init.headers as Record<string, string>)["x-marichi-event"]).toBe("invoice.paid");
    expect(await deliverWebhooks(w.db, T0, ok())).toEqual({ delivered: 0, retrying: 0, failed: 0 }); // nothing is sent twice
  });

  it("retries a failing endpoint with backoff, then gives up", async () => {
    await setup();
    await emitEvent(w.db, w.sellerId, "invoice.overdue", { invoiceNumber: "X-2" }, T0);
    const bad = vi.fn(async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    let now = T0;
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      expect(await deliverWebhooks(w.db, now, bad)).toMatchObject({ retrying: 1 });
      expect(await deliverWebhooks(w.db, now, bad)).toMatchObject({ retrying: 0, failed: 0 }); // not due again until the backoff passes
      now = new Date(now.getTime() + 13 * 3_600_000);
    }
    expect(await deliverWebhooks(w.db, now, bad)).toMatchObject({ failed: 1 });
    const [d] = await w.db.select().from(webhookDeliveries);
    expect(d).toMatchObject({ status: "failed", attempts: MAX_ATTEMPTS, lastStatusCode: 500 });
    expect(d.lastError).toMatch(/500/);
  });

  it("respects the events an endpoint asked for, and disabled endpoints get nothing", async () => {
    const ep = await setup(["invoice.paid"]);
    expect(await emitEvent(w.db, w.sellerId, "invoice.overdue", {}, T0)).toBe(0);
    expect(await emitEvent(w.db, w.sellerId, "invoice.paid", {}, T0)).toBe(1);
    await setEndpointActive(w.db, owner, ep.id, false);
    expect(await emitEvent(w.db, w.sellerId, "invoice.paid", {}, T0)).toBe(0);
  });

  it("the secret is encrypted in the database", async () => {
    const ep = await setup();
    const raw = (await w.db.execute(sql`select secret from webhook_endpoints`)).rows[0] as { secret: string };
    expect(raw.secret.startsWith("enc:v1:")).toBe(true); expect(raw.secret).not.toContain(ep.secret);
  });

  it("is fed by real events: a payout and a repayment queue webhooks for the seller", async () => {
    await setup();
    const f = await w.financed(10_00_000_00n);
    let types = (await w.db.select().from(webhookDeliveries)).map((d) => d.type);
    expect(types).toEqual(expect.arrayContaining(["offer.created", "invoice.financed"]));
    await recordIncomingPayment(w.db, { accountNumber: f.account, amount: 10_00_000_00n, utr: "UTR-ERP-1", receivedAt: new Date("2026-11-20T10:00:00Z") }, gw, new Date("2026-11-20T10:00:00Z"));
    types = (await w.db.select().from(webhookDeliveries)).map((d) => d.type);
    expect(types).toContain("invoice.paid");
  });
});

describe("invoices through the API and CSV", () => {
  it("creates an invoice from data alone, rejects unlinked buyers, and answers duplicates with the existing invoice", async () => {
    const r = await createSellerInvoice(w.db, w.sellerId, input("API-1"), "api");
    expect(r.status).toBe("validated");
    expect((await w.db.select().from(invoices).where(eq(invoices.id, r.id)))[0]).toMatchObject({ source: "api", documentRef: null });
    await expect(createSellerInvoice(w.db, w.sellerId, input("API-2", { buyerGstin: "29CCCCC3333C1Z5" }), "api")).rejects.toMatchObject({ status: 422, code: "BUYER_NOT_LINKED" });
    const dup = await createSellerInvoice(w.db, w.sellerId, input("API-1"), "api").catch((e) => e);
    expect(dup).toBeInstanceOf(ApiError);
    expect(dup).toMatchObject({ status: 409, code: "DUPLICATE_INVOICE", extra: { invoice: { number: "API-1", status: "validated" } } });
    await expect(createSellerInvoice(w.db, w.sellerId, input("API-3", { dueDate: "2026-09-01" }), "api")).rejects.toMatchObject({ status: 422 });
  });

  it("lists for both sides with offers, payouts and what is outstanding", async () => {
    const f = await w.financed(10_00_000_00n);
    const mine = await listInvoices(w.db, { businessId: w.sellerId, kind: "seller" });
    expect(mine.items[0]).toMatchObject({ status: "financed", amount: "1000000.00", buyerGstin: BUYER_GSTIN, offer: { status: "accepted" } });
    expect(mine.items[0].financedAt).not.toBeNull(); expect(mine.items[0].outstanding).not.toBeNull();
    const theirs = await listInvoices(w.db, { businessId: w.buyerId, kind: "buyer" });
    expect(theirs.items[0]).toMatchObject({ number: mine.items[0].number, seller: "Seller Co", offer: null });
    expect((await listInvoices(w.db, { businessId: w.sellerId, kind: "seller", number: mine.items[0].number })).items).toHaveLength(1);
    expect((await listInvoices(w.db, { businessId: w.sellerId, kind: "seller", status: "paid" })).items).toHaveLength(0);
    expect((await listInvoices(w.db, { businessId: w.buyerId, kind: "seller" })).items).toHaveLength(0); // never another company's invoices
    void f;
  });

  it("pages through results with a cursor", async () => {
    for (let i = 0; i < 3; i++) { await createSellerInvoice(w.db, w.sellerId, input(`P-${i}`), "api"); await new Promise((r) => setTimeout(r, 5)); }
    const first = await listInvoices(w.db, { businessId: w.sellerId, kind: "seller", limit: 2 });
    expect(first.items).toHaveLength(2); expect(first.nextBefore).not.toBeNull();
    const second = await listInvoices(w.db, { businessId: w.sellerId, kind: "seller", limit: 2, before: new Date(first.nextBefore!) });
    expect(second.items).toHaveLength(1); expect(second.nextBefore).toBeNull();
  });
});

describe("CSV import", () => {
  it("parses quotes, doubled quotes, commas and line breaks inside fields, and a byte-order mark", () => {
    expect(parseCsv('﻿a,b\n"x, y","say ""hi"""\r\n"line\nbreak",z\n')).toEqual([["a", "b"], ["x, y", 'say "hi"'], ["line\nbreak", "z"]]);
  });
  it("understands the date styles accounting tools produce", () => {
    expect(isoDate("2026-10-08")).toBe("2026-10-08"); expect(isoDate("08-10-2026")).toBe("2026-10-08"); expect(isoDate("8/10/2026")).toBe("2026-10-08");
    expect(isoDate("31-02-2026")).toBeNull(); expect(isoDate("yesterday")).toBeNull();
  });
  it("imports valid rows, reports each bad row with its line, and a dry run saves nothing", async () => {
    const csv = [
      "Invoice No,Customer GSTIN,Date,Due Date,Total,PO",
      `C-1,${BUYER_GSTIN},25-09-2026,20-11-2026,"₹1,18,000.00",PO-1`,
      `C-2,${BUYER_GSTIN},25-09-2026,20-11-2026,Rs. 50000,`,
      `C-3,29CCCCC3333C1Z5,25-09-2026,20-11-2026,50000,`,
      `C-4,${BUYER_GSTIN},not-a-date,20-11-2026,50000,`,
      `C-1,${BUYER_GSTIN},25-09-2026,20-11-2026,50000,`,
    ].join("\n");
    const dry = await importInvoices(w.db, w.sellerId, csv, { dryRun: true });
    expect(dry).toMatchObject({ valid: 2, invalid: 3, imported: 0 });
    expect(await w.db.select().from(invoices)).toHaveLength(0);
    const real = await importInvoices(w.db, w.sellerId, csv);
    expect(real).toMatchObject({ imported: 2, invalid: 3 });
    expect(real.results.filter((r) => !r.ok).map((r) => [r.line, r.number])).toEqual([[4, "C-3"], [5, "C-4"], [6, "C-1"]]);
    expect(real.results[2].error).toMatch(/not one of your linked buyers/);
    expect(real.results[3].error).toMatch(/not a date/);
    expect(real.results[4].error).toMatch(/twice/);
    const rows = await w.db.select().from(invoices);
    expect(rows.map((r) => r.source)).toEqual(["csv", "csv"]);
    expect(rows.find((r) => r.invoiceNumber === "C-1")!.amount).toBe(1_18_000_00n);
  });
  it("refuses files that are empty, missing columns, or too large", async () => {
    await expect(importInvoices(w.db, w.sellerId, "just,a,header")).rejects.toMatchObject({ code: "EMPTY_FILE" });
    await expect(importInvoices(w.db, w.sellerId, "Invoice No,Amount\nA,1")).rejects.toMatchObject({ code: "MISSING_COLUMNS" });
    const big = "invoice_number,buyer_gstin,invoice_date,due_date,amount\n" + Array.from({ length: 201 }, (_, i) => `B${i},${BUYER_GSTIN},2026-09-25,2026-11-20,1000`).join("\n");
    await expect(importInvoices(w.db, w.sellerId, big)).rejects.toMatchObject({ code: "TOO_MANY_ROWS" });
  });
});
