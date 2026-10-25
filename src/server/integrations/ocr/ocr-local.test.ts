import { afterEach, describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { createCanvas } from "@napi-rs/canvas";
import { setMarketForTests } from "../../../lib/countries";
import { amountsIn, findDate, parseInvoice } from "./parse";
import { linesFromItems } from "./text";
import { localOcr } from "./local";
import { refine } from "./llm";

afterEach(() => setMarketForTests("IN"));

const GST_INVOICE = `HARBOR TEXTILES PRIVATE LIMITED
14 Mill Road, Surat, Gujarat
GSTIN: 24ABCDE1234F1Z5
TAX INVOICE
Invoice No: HT/2026/0417        Invoice Date: 03/10/2026
PO Ref: PO-88213
Bill To:
Big Corp Retail Ltd
GSTIN: 27AAACB2230M1ZT
Description   HSN   Qty   Rate   Amount
Cotton fabric roll   5208   100   1,000.00   1,00,000.00
Sub Total   1,00,000.00
CGST 9%   9,000.00
SGST 9%   9,000.00
Grand Total   ₹ 1,18,000.00
Amount in words: One lakh eighteen thousand only
Payment terms: Net 45 days
IRN: 6b2f3c8d9a1e4f5a7b8c9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c`;

describe("reading fields from invoice text", () => {
  it("reads an Indian GST invoice: number, dates (with terms), grand total not subtotal, both GSTINs, PO and IRN", () => {
    const { fields: f, warnings } = parseInvoice(GST_INVOICE);
    expect(f).toMatchObject({
      invoiceNumber: "HT/2026/0417", invoiceDate: "2026-10-03", dueDate: "2026-11-17", totalAmount: "118000.00", currency: "INR",
      sellerGstin: "24ABCDE1234F1Z5", buyerGstin: "27AAACB2230M1ZT", poReference: "PO-88213",
      irn: "6b2f3c8d9a1e4f5a7b8c9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c", sellerName: "HARBOR TEXTILES PRIVATE LIMITED", buyerName: "Big Corp Retail Ltd",
    });
    expect(warnings.join(" ")).toMatch(/due date was worked out from the payment terms \(45 days\)/);
  });

  it("reads a table layout where the labels are on one line and the values on the next", () => {
    const { fields: f } = parseInvoice(`ACME SUPPLIES
Invoice No.   Invoice Date   Due Date
AC-1007   12-Oct-2026   11 Nov 2026
Total Amount Payable
Rs. 52,400.50`);
    expect(f).toMatchObject({ invoiceNumber: "AC-1007", invoiceDate: "2026-10-12", dueDate: "2026-11-11", totalAmount: "52400.50", currency: "INR" });
  });

  it("reads a Zambian VAT invoice by TPIN and kwacha when the market is Zambia", () => {
    setMarketForTests("ZM");
    const { fields: f } = parseInvoice(`KAFUE TRADERS LIMITED
TPIN: 1000000011
VAT INVOICE
Invoice Number: KT-3321
Date: 5 October 2026
Customer: Zambezi Retail Ltd   TPIN 2000000021
Subtotal ZMW 10,000.00
VAT 16% ZMW 1,600.00
Total ZMW 11,600.00
Due date: 04/11/2026`);
    expect(f).toMatchObject({ invoiceNumber: "KT-3321", invoiceDate: "2026-10-05", dueDate: "2026-11-04", totalAmount: "11600.00", currency: "ZMW", sellerGstin: "1000000011", buyerGstin: "2000000021" });
  });

  it("leaves a field empty rather than guessing, and says when it had to settle for a weaker clue", () => {
    const none = parseInvoice("Some text with no invoice data at all\nHello");
    expect(none.fields).toMatchObject({ invoiceNumber: null, invoiceDate: null, dueDate: null, totalAmount: null, sellerGstin: null, irn: null });
    const weak = parseInvoice("INVOICE\nInv #: A-99\nTotal 4,500.00");
    expect(weak.fields.totalAmount).toBe("4500.00");
    expect(weak.warnings.join(" ")).toMatch(/Check that it is the total payable/);
  });

  it("never takes a tax line, subtotal or amount in words for the total", () => {
    const { fields } = parseInvoice("Sub Total 10,000.00\nTotal Tax 1,800.00\nTotal Qty 40\nGrand Total 11,800.00\nAmount chargeable (in words) INR Eleven Thousand Only");
    expect(fields.totalAmount).toBe("11800.00");
  });

  it("dates are read day first in the usual shapes, and impossible ones are refused", () => {
    expect(findDate("03/10/2026")).toBe("2026-10-03");
    expect(findDate("3rd Oct, 2026")).toBe("2026-10-03");
    expect(findDate("October 3, 2026")).toBe("2026-10-03");
    expect(findDate("2026-10-03")).toBe("2026-10-03");
    expect(findDate("31/02/2026")).toBeNull();
    expect(amountsIn("Qty 5 Rate 1,000.00 Amount 1,23,456.50")).toEqual(["5", "1000.00", "123456.50"]);
  });
});

describe("text from files", () => {
  it("rebuilds lines from positioned fragments, in reading order, keeping wide gaps as column breaks", () => {
    const t = linesFromItems([
      { str: "Date: 03/10/2026", x: 300, y: 700, width: 90, fontSize: 10 }, { str: "Invoice No: A-1", x: 40, y: 700.5, width: 80, fontSize: 10 },
      { str: "Total", x: 40, y: 500, width: 30, fontSize: 10 }, { str: "1,000.00", x: 80, y: 500, width: 45, fontSize: 10 },
    ]);
    expect(t).toBe("Invoice No: A-1   Date: 03/10/2026\nTotal 1,000.00");
  });

  async function digitalPdf(lines: string[]) {
    const doc = await PDFDocument.create();
    const page = doc.addPage([595, 842]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    lines.forEach((l, i) => page.drawText(l, { x: 40, y: 780 - i * 18, size: 11, font }));
    return doc.save();
  }
  const SAMPLE = ["BLUE RIVER TRADERS", "TAX INVOICE", "Invoice No: BR-2026-55", "Invoice Date: 01/10/2026", "Due Date: 30/11/2026", "Bill To: Metro Retail Ltd", "GSTIN: 29AAACM1234A1Z5", "Grand Total: Rs. 2,36,000.00"];

  it("reads a digital PDF straight from its text layer", async () => {
    const r = await localOcr({ llm: null }).extractInvoice({ bytes: await digitalPdf(SAMPLE), mime: "application/pdf" });
    expect(r.simulated).toBe(false);
    expect(r.fields).toMatchObject({ invoiceNumber: "BR-2026-55", invoiceDate: "2026-10-01", dueDate: "2026-11-30", totalAmount: "236000.00", buyerGstin: "29AAACM1234A1Z5" });
    expect(r.warnings?.join(" ") ?? "").not.toMatch(/picture/);
  }, 30_000);

  /** A picture of an invoice: black text on white, the way a scan or a clean photo looks. */
  function picture(lines: string[]) {
    const c = createCanvas(1400, 900);
    const g = c.getContext("2d");
    g.fillStyle = "#fff"; g.fillRect(0, 0, 1400, 900);
    g.fillStyle = "#000"; g.font = "34px sans-serif";
    lines.forEach((l, i) => g.fillText(l, 60, 90 + i * 70));
    return c.toBuffer("image/png");
  }

  it("reads a photo or scan with Tesseract", async () => {
    const r = await localOcr({ llm: null }).extractInvoice({ bytes: new Uint8Array(picture(SAMPLE)), mime: "image/png" });
    expect(r.fields.invoiceNumber).toBe("BR-2026-55");
    expect(r.fields.invoiceDate).toBe("2026-10-01");
    expect(r.fields.totalAmount).toBe("236000.00");
    expect(r.warnings?.[0]).toMatch(/read from a picture/);
  }, 90_000);

  it("reads a scanned PDF (a PDF that is only a picture) by drawing it first", async () => {
    const doc = await PDFDocument.create();
    const img = await doc.embedPng(picture(SAMPLE));
    const page = doc.addPage([595, 380]);
    page.drawImage(img, { x: 0, y: 0, width: 595, height: 380 });
    const r = await localOcr({ llm: null }).extractInvoice({ bytes: await doc.save(), mime: "application/pdf" });
    expect(r.fields.invoiceNumber).toBe("BR-2026-55");
    expect(r.fields.totalAmount).toBe("236000.00");
    expect(r.warnings?.[0]).toMatch(/read from a picture/);
  }, 120_000);

  it("refuses other file types and files with nothing readable", async () => {
    await expect(localOcr({ llm: null }).extractInvoice({ bytes: new Uint8Array([1]), mime: "image/svg+xml" })).rejects.toThrow(/PDF, PNG or JPEG/);
    await expect(localOcr({ llm: null }).extractInvoice({ bytes: await digitalPdf([]), mime: "application/pdf" })).rejects.toThrow(/no readable text/);
  }, 60_000);
});

describe("the optional free model as a second opinion", () => {
  const base = () => parseInvoice("ACME\nInvoice No: X-1\nGrand Total 5,000.00\nBill To: Delta Ltd");
  const ask = (reply: unknown, ok = true) => ({ url: "http://local/v1", model: "m", fetch: (async () => ({ ok, status: ok ? 200 : 500, json: async () => ({ choices: [{ message: { content: JSON.stringify(reply) } }] }) })) as unknown as typeof fetch });

  it("fills a gap with a value that appears in the document, and drops one that does not", async () => {
    const text = "ACME\nInvoice No: X-1\nGrand Total 5,000.00\nBill To: Delta Ltd\nPO 7781";
    const r = await refine(text, base(), ask({ poReference: "7781", buyerName: "Imaginary Corp", totalAmount: 9999, invoiceDate: "2026-13-45" }));
    expect(r.fields.poReference).toBe("7781");
    expect(r.fields.totalAmount).toBe("5000.00"); // 9999 is not in the text
    expect(r.fields.invoiceDate).toBeNull(); // not a real date
  });

  it("falls back to the rules reading, with a note, when the helper is down", async () => {
    const r = await localOcr({ llm: { url: "http://local/v1", model: "m", fetch: (async () => { throw new Error("connection refused"); }) as unknown as typeof fetch } })
      .extractInvoice({ bytes: await (async () => { const d = await PDFDocument.create(); const p = d.addPage(); const f = await d.embedFont(StandardFonts.Helvetica); ["Invoice No: Z-9", "Grand Total 700.00", "Invoice Date: 02/10/2026"].forEach((l, i) => p.drawText(l, { x: 40, y: 700 - i * 20, size: 12, font: f })); return d.save(); })(), mime: "application/pdf" });
    expect(r.fields.invoiceNumber).toBe("Z-9");
    expect(r.warnings?.join(" ")).toMatch(/helper was not available/);
  }, 30_000);
});
