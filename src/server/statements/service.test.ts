import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";
import { auditLog, businessStatementLines } from "../db/schema";
import { world } from "../testkit";
import { readDocument } from "../vault";
import { latestSummary, listStatements, uploadStatement } from "./service";

const CSV = [
  "HDFC BANK LTD.", "Account No : 50100123456789",
  "Date,Narration,Withdrawal Amt.,Deposit Amt.,Closing Balance",
  '01/04/26,"UPI-ACME TRADERS-ac@okhdfc-HDFC0000001-41",,"1,50,000.00","2,50,000.00"',
  '05/04/26,NEFT DR-ICIC0000123-RAJ SUPPLIES-INV12,"40,000.00",,"2,10,000.00"',
  '10/04/26,IMPS-998877-KIRAN STORES,,25000.50,"2,35,000.50"',
].join("\n");
const file = (text: string, fileName = "apr.csv", mime = "text/csv") => ({ bytes: Buffer.from(text), mime, fileName });

describe("uploading a bank statement", () => {
  it("stores the file, reads it, and keeps the lines and the figures", async () => {
    const { db, sellerId, sellerActor } = await world();
    const row = await uploadStatement(db, sellerActor, file(CSV));
    expect(row).toMatchObject({ businessId: sellerId, status: "parsed", failure: null, bankName: "HDFC Bank", accountLast4: "6789", periodFrom: "2026-04-01", periodTo: "2026-04-10", fileName: "apr.csv" });
    expect(row.documentRef).toMatch(/^[a-f0-9]{64}\.csv$/);
    expect((await readDocument(row.documentRef)).bytes.toString()).toBe(CSV);

    const lines = await db.select().from(businessStatementLines).where(eq(businessStatementLines.statementId, row.id)).orderBy(businessStatementLines.on);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ on: "2026-04-01", credit: 15_000_000n, debit: 0n, balance: 25_000_000n });
    expect(lines[2]).toMatchObject({ credit: 2_500_050n, balance: 23_500_050n });

    const latest = await latestSummary(db, sellerId);
    expect(latest?.statement.id).toBe(row.id);
    expect(latest?.summary).toMatchObject({ rows: 3, months: 1, totalCredits: 17_500_050n, totalDebits: 4_000_000n });
    expect(latest?.summary.integrity.balanceBreaks).toBe(0);
    expect((await db.select().from(auditLog).where(eq(auditLog.action, "statement.uploaded")))).toHaveLength(1);
  });

  it("lists newest first and gives the latest readable one", async () => {
    const { db, sellerId, sellerActor } = await world();
    const a = await uploadStatement(db, sellerActor, file(CSV, "one.csv"));
    const bad = await uploadStatement(db, sellerActor, file("nothing useful here", "two.csv"));
    expect((await listStatements(db, sellerId)).map((r) => r.id)).toEqual([bad.id, a.id]);
    expect((await latestSummary(db, sellerId))?.statement.id).toBe(a.id); // the failed one has no figures
  });

  it("reads a text PDF", async () => {
    const { db, sellerActor } = await world();
    const d = await PDFDocument.create();
    const p = d.addPage([595, 842]);
    const f = await d.embedFont("Helvetica");
    const rows: [number, string[]][] = [[740, ["Date", "Narration", "Withdrawal", "Deposit", "Balance"]], [720, ["01/04/2026", "UPI/CR/4/ACME TRADERS/HDFC", "", "10,000.00", "10,000.00"]],
      [700, ["02/04/2026", "NEFT-HDFCN1-RAJ SUPPLIES", "2,000.00", "", "8,000.00"]], [680, ["03/04/2026", "UPI/CR/5/ACME TRADERS/HDFC", "", "500.00", "8,500.00"]]];
    for (const [y, cells] of rows) cells.forEach((t, i) => t && p.drawText(t, { x: [40, 110, 330, 400, 480][i], y, size: 9, font: f }));
    const row = await uploadStatement(db, sellerActor, { bytes: Buffer.from(await d.save()), mime: "application/pdf", fileName: "apr.pdf" });
    expect(row.status).toBe("parsed");
    expect(row.documentRef).toMatch(/\.pdf$/);
  });

  it("a file that cannot be read is kept with the reason, and has no lines", async () => {
    const { db, sellerId, sellerActor } = await world();
    const row = await uploadStatement(db, sellerActor, file("just some words\nand more words"));
    expect(row).toMatchObject({ status: "failed", summary: null, periodFrom: null });
    expect(row.failure).toMatch(/could not find the list of transactions/);
    expect(await db.select().from(businessStatementLines).where(eq(businessStatementLines.statementId, row.id))).toHaveLength(0);
    expect(await latestSummary(db, sellerId)).toBeNull();

    const d = await PDFDocument.create(); d.addPage([595, 842]); // a scan has no text
    const scan = await uploadStatement(db, sellerActor, { bytes: Buffer.from(await d.save()), mime: "application/pdf", fileName: "scan.pdf" });
    expect(scan.failure).toMatch(/picture of a statement/);
  });

  it("only a seller company's working roles may upload; size and type are checked", async () => {
    const { db, sellerActor, buyerId } = await world();
    await expect(uploadStatement(db, { ...sellerActor, orgRole: "viewer" }, file(CSV))).rejects.toThrow(/not allowed/);
    await expect(uploadStatement(db, { id: sellerActor.id, role: "buyer", businessId: buyerId }, file(CSV))).rejects.toThrow(/Only a seller/);
    await expect(uploadStatement(db, sellerActor, { bytes: Buffer.alloc(4 * 1024 * 1024 + 1), mime: "text/csv", fileName: "big.csv" })).rejects.toThrow(/4 MB/);
    await expect(uploadStatement(db, sellerActor, { bytes: Buffer.from("x"), mime: "image/png", fileName: "a.png" })).rejects.toThrow(/PDF or a CSV/);
    expect(await listStatements(db, sellerActor.businessId)).toHaveLength(0);
  });
});
