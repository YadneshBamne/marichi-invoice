import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { parseAmount, parseDate, parseStatement, splitCsv, StatementError } from "./parse";

// Layout 1: HDFC style. Bank preamble, separate Withdrawal and Deposit columns, Indian grouping, dd/mm/yy, a quoted narration with a comma.
const HDFC = [
  "HDFC BANK LTD.,,,,,,",
  "Account Branch : PUNE,,,,,,",
  "Account No : 50100123456789   Open Date : 01/01/2020,,,,,,",
  "Statement From : 01/04/2026 To : 30/04/2026,,,,,,",
  ",,,,,,",
  "Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance",
  '01/04/26,"UPI-ACME TRADERS, PUNE-acme@okhdfc-HDFC0000001-412345",0000412345,01/04/26,,"1,50,000.00","2,50,000.00"',
  "05/04/26,NEFT DR-ICIC0000123-RAJ SUPPLIES-INV12,N123,05/04/26,\"40,000.00\",,\"2,10,000.00\"",
  "10/04/26,IMPS-998877-KIRAN STORES,998877,10/04/26,,25000.50,\"2,35,000.50\"",
  "15/04/26,POS 4567XXXXXX1234 FUEL,,15/04/26,\"1,235.25\",,\"2,33,765.25\"",
  ",,,,,,",
  "STATEMENT SUMMARY,,,,,,",
].join("\r\n");

// Layout 2: single Amount column with Dr/Cr, dd-MMM-yyyy, newest first, a masked account number.
const ICICI = [
  "Statement of Account",
  "ICICI Bank Limited",
  '"Account Number: XXXXXXXX4321"',
  "Transaction Date,Transaction Remarks,Amount (INR),Dr/Cr,Balance (INR)",
  '15-Apr-2026,"POS FUEL, PUNE",1235.25,DR,"233,765.25"',
  "10-Apr-2026,IMPS/KIRAN STORES,25000.50,CR,235000.50",
  "05-Apr-2026,NEFT/RAJ SUPPLIES,40000.00,DR,210000.00",
  "01-Apr-2026,UPI/ACME TRADERS,150000.00,CR,250000.00",
].join("\n");

const csv = (s: string, name = "statement.csv") => parseStatement(Buffer.from(s), "csv", name);
const rs = (n: number) => BigInt(Math.round(n * 100));

describe("numbers and dates", () => {
  it("reads Indian grouping, symbols, Dr/Cr and brackets into paise", () => {
    expect(parseAmount("1,23,456.78")).toEqual({ v: 12345678n, dir: null, neg: false });
    expect(parseAmount("₹ 500")).toMatchObject({ v: 50000n });
    expect(parseAmount("1,000.5 Dr")).toEqual({ v: 100050n, dir: "dr", neg: false });
    expect(parseAmount("Cr 20.00")).toMatchObject({ v: 2000n, dir: "cr" });
    expect(parseAmount("(250.00)")).toMatchObject({ v: 25000n, neg: true });
    expect(parseAmount("-1200")).toMatchObject({ v: 120000n, neg: true });
    expect(parseAmount("0.00")).toMatchObject({ v: 0n });
    expect(parseAmount("")).toBeNull();
    expect(parseAmount("-")).toBeNull();
    expect(parseAmount("abc")).toBeNull();
  });
  it("reads the date styles banks use, and refuses impossible dates", () => {
    expect(parseDate("05/04/26")).toBe("2026-04-05");
    expect(parseDate("05/04/2026")).toBe("2026-04-05");
    expect(parseDate("05-Apr-2026")).toBe("2026-04-05");
    expect(parseDate("5 April 26")).toBe("2026-04-05");
    expect(parseDate("2026-04-05")).toBe("2026-04-05");
    expect(parseDate("05.04.2026 10:31:00")).toBe("2026-04-05");
    expect(parseDate("31/02/2026")).toBeNull();
    expect(parseDate("Narration")).toBeNull();
  });
  it("splits quoted fields with commas and other separators", () => {
    expect(splitCsv('a,"b, c","d ""e"""\n1,2,3,4')[0]).toEqual(["a", "b, c", 'd "e"']);
    expect(splitCsv("Date\tNarration\tDr\tCr\n01/04/26\tX\t1,000.00\t")[1]).toEqual(["01/04/26", "X", "1,000.00", ""]);
  });
});

describe("CSV statements", () => {
  it("reads the HDFC layout past the preamble", async () => {
    const r = await csv(HDFC);
    expect(r).toMatchObject({ bankName: "HDFC Bank", accountLast4: "6789", periodFrom: "2026-04-01", periodTo: "2026-04-15" });
    expect(r.lines).toEqual([
      { on: "2026-04-01", narration: "UPI-ACME TRADERS, PUNE-acme@okhdfc-HDFC0000001-412345", debit: 0n, credit: rs(150000), balance: rs(250000) },
      { on: "2026-04-05", narration: "NEFT DR-ICIC0000123-RAJ SUPPLIES-INV12", debit: rs(40000), credit: 0n, balance: rs(210000) },
      { on: "2026-04-10", narration: "IMPS-998877-KIRAN STORES", debit: 0n, credit: rs(25000.5), balance: 23500050n },
      { on: "2026-04-15", narration: "POS 4567XXXXXX1234 FUEL", debit: rs(1235.25), credit: 0n, balance: 23376525n },
    ]);
  });

  it("reads the single Amount + Dr/Cr layout and puts a newest-first file in date order", async () => {
    const r = await csv(ICICI);
    expect(r).toMatchObject({ bankName: "ICICI Bank", accountLast4: "4321", periodFrom: "2026-04-01", periodTo: "2026-04-15" });
    expect(r.lines.map((l) => l.on)).toEqual(["2026-04-01", "2026-04-05", "2026-04-10", "2026-04-15"]);
    expect(r.lines[0]).toMatchObject({ credit: rs(150000), debit: 0n, balance: rs(250000) });
    expect(r.lines[3]).toMatchObject({ debit: rs(1235.25), credit: 0n, narration: "POS FUEL, PUNE" });
  });

  it("asks for a different download when a single Amount column gives no way to tell money in from money out", async () => {
    const head = "Date,Particulars,Amount,Balance";
    await expect(csv([head, "01/04/2026,A,1000.00,5000.00", "02/04/2026,B,200.00,4800.00", "03/04/2026,C,300.00,5100.00"].join("\n"))).rejects.toThrow(/which amounts are money out/);
    // once a row says which way it went (a minus sign here), the balance decides the rest
    const r = await csv([head, "01/04/2026,A,-1000.00,5000.00", "02/04/2026,B,200.00,4800.00", "03/04/2026,C,300.00,5100.00"].join("\n"));
    expect(r.lines.map((l) => [l.debit, l.credit])).toEqual([[100000n, 0n], [20000n, 0n], [0n, 30000n]]);
  });

  it("says plainly when the file cannot be used", async () => {
    await expect(csv("hello\nworld\n")).rejects.toThrow(/could not find the list of transactions/);
    await expect(csv("Date,Narration,Debit,Credit,Balance\n01/04/2026,X,10.00,,90.00\n02/04/2026,Y,,5.00,95.00")).rejects.toThrow(/only 2 transactions/);
    await expect(csv("")).rejects.toBeInstanceOf(StatementError);
    await expect(csv("%PDF-1.4 not really a csv")).rejects.toThrow(/PDF with a \.csv name/);
  });
});

async function pdf(rows: [number, string[]][]) {
  const d = await PDFDocument.create();
  const p = d.addPage([595, 842]);
  const f = await d.embedFont(StandardFonts.Helvetica);
  for (const [y, cells] of rows) cells.forEach((t, i) => t && p.drawText(t, { x: [40, 110, 330, 400, 480][i], y, size: 9, font: f }));
  return Buffer.from(await d.save());
}

describe("PDF statements", () => {
  it("rebuilds the table from positions, keeps an empty Debit column in place and joins a wrapped narration", async () => {
    const file = await pdf([
      [800, ["ICICI Bank Limited"]], [785, ["Account No: 123456781234"]],
      [740, ["Date", "Narration", "Withdrawal", "Deposit", "Balance"]],
      [720, ["01/04/2026", "UPI/CR/412/ACME TRADERS/HDFC", "", "1,50,000.00", "2,50,000.00"]],
      [700, ["05/04/2026", "NEFT-HDFCN123-RAJ SUPPLIES", "40,000.00", "", "2,10,000.00"]],
      [690, ["", "PVT LTD INVOICE 44"]],
      [670, ["09/04/2026", "IMPS/CR/998/KIRAN STORES", "", "25,000.00", "2,35,000.00"]],
    ]);
    const r = await parseStatement(file, "pdf", "stmt.pdf");
    expect(r).toMatchObject({ bankName: "ICICI Bank", accountLast4: "1234", periodFrom: "2026-04-01", periodTo: "2026-04-09" });
    expect(r.lines).toEqual([
      { on: "2026-04-01", narration: "UPI/CR/412/ACME TRADERS/HDFC", debit: 0n, credit: rs(150000), balance: rs(250000) },
      { on: "2026-04-05", narration: "NEFT-HDFCN123-RAJ SUPPLIES PVT LTD INVOICE 44", debit: rs(40000), credit: 0n, balance: rs(210000) },
      { on: "2026-04-09", narration: "IMPS/CR/998/KIRAN STORES", debit: 0n, credit: rs(25000), balance: rs(235000) },
    ]);
  });

  it("refuses a scan (a PDF with no text) and a file that is not a PDF", async () => {
    const d = await PDFDocument.create(); d.addPage([595, 842]);
    await expect(parseStatement(Buffer.from(await d.save()), "pdf")).rejects.toThrow(/picture of a statement/);
    await expect(parseStatement(Buffer.from("not a pdf"), "pdf")).rejects.toThrow(/could not be opened/);
  });
});
