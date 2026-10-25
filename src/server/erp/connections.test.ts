import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { auditLog, erpConnections, invoices } from "../db/schema";
import { world } from "../testkit";
import { accountingFor, connectionOf, disconnect, saveConnection, syncConnection, type Accounting } from "./connections";
import { ConnectorError, type ErpInvoiceRow } from "./connectors/types";

let w: Awaited<ReturnType<typeof world>>;
beforeEach(async () => { w = await world(); });

const row = (n: string, o: Partial<ErpInvoiceRow> = {}): ErpInvoiceRow => ({
  externalId: n, invoiceNumber: n, buyerName: "Big Corp", buyerTaxId: "29BBBBB2222B1Z5", invoiceDate: "2026-09-25", dueDate: "2026-11-20",
  amountMinor: 250_000_00n, currency: "INR", poReference: `PO-${n}`, ...o,
});
/** A stand-in for the provider: tokens come back as given, invoices as listed. */
const fake = (rows: ErpInvoiceRow[], o: Partial<Accounting> = {}): Accounting => ({
  label: "Fake", authorizeUrl: (s) => `https://x.test/auth?state=${s}`,
  connect: async () => ({ tokens: { accessToken: "a1", refreshToken: "r1", expiresIn: 3600 }, org: "org-7" }),
  refresh: async (rt) => ({ accessToken: "a2", refreshToken: rt, expiresIn: 3600 }),
  list: async () => rows, ...o,
});
const save = (accounting: Accounting) => saveConnection(w.db, { businessId: w.sellerId, userId: w.sellerActor.id, provider: "zoho", code: "c", accounting });

describe("which providers are offered", () => {
  it("only those with keys, with the right return address and region", () => {
    expect(accountingFor("zoho", {})).toBeNull();
    expect(accountingFor("quickbooks", { QBO_CLIENT_ID: "x" })).toBeNull();
    const z = accountingFor("zoho", { ZOHO_CLIENT_ID: "id", ZOHO_CLIENT_SECRET: "s", ZOHO_DC: "in" }, "https://app.test")!;
    const u = new URL(z.authorizeUrl("st"));
    expect(u.host).toBe("accounts.zoho.in");
    expect(u.searchParams.get("redirect_uri")).toBe("https://app.test/api/erp/zoho/callback");
    const q = accountingFor("quickbooks", { QBO_CLIENT_ID: "id", QBO_CLIENT_SECRET: "s" }, "https://app.test")!;
    expect(new URL(q.authorizeUrl("st")).searchParams.get("redirect_uri")).toBe("https://app.test/api/erp/quickbooks/callback");
  });
});

describe("connecting", () => {
  it("stores the link (encrypted at rest, replaced on reconnect) and records it", async () => {
    await save(fake([]));
    await save(fake([], { connect: async () => ({ tokens: { accessToken: "a", refreshToken: "r-new", expiresIn: 1 }, org: "org-8" }) }));
    const c = (await connectionOf(w.db, w.sellerId, "zoho"))!;
    expect(c).toMatchObject({ externalOrg: "org-8", refreshToken: "r-new", status: "active", connectedBy: w.sellerActor.id });
    const [raw] = (await w.db.execute(`select refresh_token from erp_connections`)).rows as { refresh_token: string }[];
    expect(raw.refresh_token).not.toContain("r-new"); // only ciphertext in the database
    expect((await w.db.select().from(auditLog).where(eq(auditLog.action, "erp.connect"))).length).toBe(2);
  });

  it("says plainly when the platform has no keys for the provider", async () => {
    await expect(saveConnection(w.db, { businessId: w.sellerId, userId: w.sellerActor.id, provider: "quickbooks", code: "c", accounting: null })).rejects.toThrow(/not set up/);
  });
});

describe("importing from a connected system", () => {
  it("brings in new invoices, leaves out those already on the platform, and remembers the result", async () => {
    await save(fake([]));
    const first = await syncConnection(w.db, w.sellerId, "zoho", { accounting: fake([row("Z-1"), row("Z-2")]) });
    expect(first).toMatchObject({ found: 2, skipped: 0, imported: 2, invalid: 0 });
    const again = await syncConnection(w.db, w.sellerId, "zoho", { accounting: fake([row("Z-1"), row("Z-2"), row("Z-3", { poReference: "PO-new" })]) });
    expect(again).toMatchObject({ found: 3, skipped: 2, imported: 1 });
    expect((await w.db.select().from(invoices).where(eq(invoices.invoiceNumber, "Z-3")))[0].source).toBe("erp");
    expect((await connectionOf(w.db, w.sellerId, "zoho"))).toMatchObject({ status: "active", lastSyncNote: "1 imported, 0 could not be, 2 already on the platform" });
  });

  it("a check changes nothing, and unusable rows are explained", async () => {
    await save(fake([]));
    const r = await syncConnection(w.db, w.sellerId, "zoho", { dryRun: true, accounting: fake([row("Z-1"), row("Z-2", { buyerTaxId: null })]) });
    expect(r).toMatchObject({ found: 2, valid: 1, invalid: 1, imported: 0 });
    expect(r.results.find((x) => !x.ok)!.error).toMatch(/no GSTIN/);
    expect((await w.db.select().from(invoices)).length).toBe(0);
    expect((await connectionOf(w.db, w.sellerId, "zoho"))!.lastSyncAt).toBeNull();
  });

  it("keeps a newer refresh token when the provider issues one", async () => {
    await save(fake([]));
    await syncConnection(w.db, w.sellerId, "zoho", { accounting: fake([], { refresh: async () => ({ accessToken: "a", refreshToken: "r-rotated", expiresIn: 1 }) }) });
    expect((await connectionOf(w.db, w.sellerId, "zoho"))!.refreshToken).toBe("r-rotated");
  });

  it("marks the link as needing a reconnect when the provider turns it down, but not for a passing outage", async () => {
    await save(fake([]));
    const denied = fake([], { refresh: vi.fn(async () => { throw new ConnectorError("Zoho rejected the request: invalid_code", 400); }) });
    await expect(syncConnection(w.db, w.sellerId, "zoho", { accounting: denied })).rejects.toThrow(/invalid_code/);
    expect(await connectionOf(w.db, w.sellerId, "zoho")).toMatchObject({ status: "expired", lastSyncNote: expect.stringContaining("invalid_code") });
    await save(fake([]));
    const down = fake([], { list: async () => { throw new ConnectorError("could not reach Zoho Books; try again shortly"); } });
    await expect(syncConnection(w.db, w.sellerId, "zoho", { accounting: down })).rejects.toThrow(/could not reach/);
    expect((await connectionOf(w.db, w.sellerId, "zoho"))!.status).toBe("active");
  });

  it("refuses when nothing is connected", async () => {
    await expect(syncConnection(w.db, w.sellerId, "zoho", { accounting: fake([]) })).rejects.toThrow(/not connected/);
  });
});

describe("disconnecting", () => {
  it("removes the stored link and records it", async () => {
    await save(fake([]));
    await disconnect(w.db, { businessId: w.sellerId, userId: w.sellerActor.id, provider: "zoho" });
    expect(await w.db.select().from(erpConnections)).toHaveLength(0);
    expect((await w.db.select().from(auditLog).where(eq(auditLog.action, "erp.disconnect"))).length).toBe(1);
  });
});
