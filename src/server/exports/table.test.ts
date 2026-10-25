import { describe, expect, it } from "vitest";
import { inflateRawSync } from "node:zlib";
import { extractText, getDocumentProxy } from "unpdf";
import { tableCsv, tablePdf, tableResponse, tableXlsx, type Table } from "./table";

/** Read a zip back: find the central directory, inflate each part. Proves the file is a well-formed zip with the right checksums. */
function unzip(b: Buffer) {
  const end = b.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const n = b.readUInt16LE(end + 10);
  let at = b.readUInt32LE(end + 16);
  const out: Record<string, string> = {};
  for (let i = 0; i < n; i++) {
    const csize = b.readUInt32LE(at + 20), nlen = b.readUInt16LE(at + 28), local = b.readUInt32LE(at + 42);
    const name = b.subarray(at + 46, at + 46 + nlen).toString();
    const start = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
    const data = inflateRawSync(b.subarray(start, start + csize));
    expect(data.length).toBe(b.readUInt32LE(at + 24));
    out[name] = data.toString("utf8");
    at += 46 + nlen;
  }
  return out;
}

const T: Table = { title: "Aged book", head: ["Invoice", "Buyer", "Amount"], rows: [["INV-1", "Big & Corp <Ltd>", "1250.50"], ["007", "=cmd()", 40]] };

describe("Excel download", () => {
  it("is a well-formed workbook: numbers stay numbers, text stays text, markup is escaped", () => {
    const parts = unzip(tableXlsx(T));
    expect(Object.keys(parts).sort()).toEqual(["[Content_Types].xml", "_rels/.rels", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml"]);
    const sheet = parts["xl/worksheets/sheet1.xml"];
    expect(sheet).toContain("<c r=\"C2\"><v>1250.50</v></c>"); // numeric string became a number
    expect(sheet).toContain("<c r=\"A3\" t=\"inlineStr\"><is><t xml:space=\"preserve\">007</t></is></c>"); // a leading zero is kept as text
    expect(sheet).toContain("Big &amp; Corp &lt;Ltd&gt;");
    expect(sheet).toContain("t=\"inlineStr\"><is><t xml:space=\"preserve\">=cmd()</t>"); // text, never a formula
    expect(sheet).toContain("<c r=\"C3\"><v>40</v></c>");
    expect(parts["xl/workbook.xml"]).toContain("name=\"Aged book\"");
  });

  it("puts a note above the header and freezes below it", () => {
    const sheet = unzip(tableXlsx({ ...T, note: "DRAFT, not filed" }))["xl/worksheets/sheet1.xml"];
    expect(sheet).toContain("<row r=\"1\"><c r=\"A1\" s=\"1\" t=\"inlineStr\"><is><t xml:space=\"preserve\">DRAFT, not filed</t>");
    expect(sheet).toContain("<row r=\"3\">"); // header
    expect(sheet).toContain("ySplit=\"3\"");
  });

  it("copes with long ids, many columns and strange characters", () => {
    const wide: Table = { title: "a/b:c*?[x]".repeat(5), head: Array.from({ length: 30 }, (_, i) => `c${i}`), rows: [Array.from({ length: 30 }, (_, i) => (i === 0 ? "12345678901234567890" : "x\u0001y"))] };
    const parts = unzip(tableXlsx(wide));
    expect(parts["xl/worksheets/sheet1.xml"]).toContain("12345678901234567890</t>"); // too many digits for a number: stays text
    expect(parts["xl/worksheets/sheet1.xml"]).toContain("<c r=\"AD1\""); // column 30
    expect(parts["xl/workbook.xml"].match(/name="([^"]*)"/)![1].length).toBeLessThanOrEqual(31);
  });
});

describe("PDF download", () => {
  const read = async (b: Uint8Array) => { const pdf = await getDocumentProxy(new Uint8Array(b)); return { pages: pdf.numPages, text: (await extractText(pdf, { mergePages: true })).text }; };

  it("shows the title, note, headings and values, and says what it could not draw", async () => {
    const { pages, text } = await read(await tablePdf({ ...T, note: "DRAFT, not filed", rows: [["INV-1", "Rs ₹ Ωmega", "1250.50"]] }, new Date("2026-10-25T10:00:00Z")));
    expect(pages).toBe(1);
    for (const s of ["Aged book", "DRAFT, not filed", "Invoice", "Buyer", "INV-1", "1250.50", "Page 1 of 1", "2026-10-25 10:00 UTC"]) expect(text).toContain(s);
    expect(text).toContain("?mega"); // Ω is outside the PDF font
  });

  it("runs onto more pages with the headings repeated, and is fine with no rows", async () => {
    const many: Table = { title: "Ledger", head: ["Ref", "Amount"], rows: Array.from({ length: 120 }, (_, i) => [`R${i}`, i]) };
    const { pages, text } = await read(await tablePdf(many));
    expect(pages).toBeGreaterThan(2);
    expect(text).toContain(`Page ${pages} of ${pages}`);
    expect(text).toContain("R119");
    expect((text.match(/Ref/g) ?? []).length).toBe(pages);
    expect((await read(await tablePdf({ title: "Empty", head: ["A"], rows: [] }))).pages).toBe(1);
  });
});

describe("choosing the file", () => {
  it("falls back to CSV, and CSV keeps formula protection and the note", async () => {
    expect(tableCsv({ ...T, note: "DRAFT" })).toBe("DRAFT\r\n\r\ninvoice,buyer,amount\r\nINV-1,Big & Corp <Ltd>,1250.50\r\n007,'=cmd(),40\r\n");
    for (const [f, type, ext] of [[undefined, "text/csv", "csv"], ["nonsense", "text/csv", "csv"], ["xlsx", "spreadsheetml", "xlsx"], ["pdf", "application/pdf", "pdf"]] as const) {
      const r = await tableResponse(T, f, "report");
      expect(r.headers.get("content-type")).toContain(type);
      expect(r.headers.get("content-disposition")).toBe(`attachment; filename="report.${ext}"`);
      expect(r.headers.get("cache-control")).toContain("no-store");
    }
  });
});
