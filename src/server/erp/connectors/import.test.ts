import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { invoices } from "../../db/schema";
import { world } from "../../testkit";
import { importErpRows } from "./import";
import type { ErpInvoiceRow } from "./types";

let w: Awaited<ReturnType<typeof world>>;
beforeEach(async () => { w = await world(); });

const row = (o: Partial<ErpInvoiceRow> = {}): ErpInvoiceRow => ({
  externalId: "x1", invoiceNumber: "TLY-1", buyerName: "Big Corp", buyerTaxId: "29BBBBB2222B1Z5", invoiceDate: "2026-09-25", dueDate: "2026-11-20",
  amountMinor: 118_000_00n, currency: "INR", poReference: "PO-9", ...o,
});

describe("importing rows from an accounting system", () => {
  it("creates each good invoice as from an upload, marked as coming from the accounting system, and refuses a repeat", async () => {
    const r = await importErpRows(w.db, w.sellerId, [row(), row({ invoiceNumber: "TLY-2", amountMinor: 250_000_00n, poReference: "PO-10" })]);
    expect(r.results.map((x) => x.error ?? "ok")).toEqual(["ok", "ok"]);
    expect(r).toMatchObject({ imported: 2, valid: 2, invalid: 0 });
    const [inv] = await w.db.select().from(invoices).where(eq(invoices.invoiceNumber, "TLY-1"));
    expect(inv).toMatchObject({ source: "erp", amount: 118_000_00n, poReference: "PO-9" });
    const again = await importErpRows(w.db, w.sellerId, [row()]);
    expect(again.results[0]).toMatchObject({ ok: false, error: expect.stringMatching(/already exists/) });
  });

  it("says in plain words why a row cannot be imported, and still imports the others", async () => {
    const r = await importErpRows(w.db, w.sellerId, [
      row({ invoiceNumber: "A", buyerTaxId: null, buyerName: "Nobody Traders" }),
      row({ invoiceNumber: "B", dueDate: null }),
      row({ invoiceNumber: "C", currency: "USD" }),
      row({ invoiceNumber: "D", buyerTaxId: "27AAAAA1111A1Z5" }), // a company that is not one of this seller's buyers
      row({ invoiceNumber: "E" }),
      row({ invoiceNumber: "E" }),
    ]);
    const err = (n: string) => r.results.filter((x) => x.number === n).map((x) => x.error ?? "ok");
    expect(err("A")[0]).toMatch(/no GSTIN in your accounting system and is not the name of one of your linked buyers/);
    expect(err("B")[0]).toMatch(/no due date/);
    expect(err("C")[0]).toMatch(/in USD; only INR/);
    expect(err("D")[0]).toMatch(/not one of your linked buyers/);
    expect(err("E")).toEqual(["ok", "this invoice number appears twice"]);
    expect(r.imported).toBe(1);
  });

  it("recognises a buyer by its name when the accounting system holds no GST number", async () => {
    const r = await importErpRows(w.db, w.sellerId, [row({ invoiceNumber: "N-1", buyerTaxId: null, buyerName: "  BIG   corp " })]);
    expect(r).toMatchObject({ imported: 1, invalid: 0 });
    const [inv] = await w.db.select().from(invoices).where(eq(invoices.invoiceNumber, "N-1"));
    expect(inv.buyerId).toBe(w.buyerId);
  });

  it("a dry run reports the same problems and creates nothing", async () => {
    await importErpRows(w.db, w.sellerId, [row()]);
    const r = await importErpRows(w.db, w.sellerId, [row(), row({ invoiceNumber: "NEW", buyerTaxId: "27AAAAA1111A1Z5" }), row({ invoiceNumber: "OK" })], { dryRun: true });
    expect(r).toMatchObject({ imported: 0, valid: 1, invalid: 2 });
    expect((await w.db.select().from(invoices)).length).toBe(1);
  });

  it("refuses an empty list and an oversized one", async () => {
    await expect(importErpRows(w.db, w.sellerId, [])).rejects.toThrow(/no invoices were found/);
    await expect(importErpRows(w.db, w.sellerId, Array.from({ length: 201 }, (_, i) => row({ invoiceNumber: `N${i}` })))).rejects.toThrow(/at most 200/);
  });
});
