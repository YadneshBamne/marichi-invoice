import { beforeEach, describe, expect, it, vi } from "vitest";
import { mock } from "./mock";
import { harden } from "./harden";
import type { Adapters } from "./gateway";

const parse = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { parse: (...a: unknown[]) => parse(...a) }; } }));

const FIELDS = { invoiceNumber: "INV-77", invoiceDate: "2026-10-01", dueDate: "2026-11-30", totalAmount: "118000.00", currency: "INR", sellerName: "Harbor Textiles", sellerGstin: "27ABCDE1234F1Z5", buyerName: "Big Corp", buyerGstin: null, irn: null, poReference: "PO-9" };
beforeEach(() => parse.mockReset());

describe("invoice reading with Claude", () => {
  it("sends a PDF as a document block and an image as an image block, with structured output and low effort", async () => {
    const { anthropicOcr } = await import("./anthropic-ocr");
    parse.mockResolvedValue({ stop_reason: "end_turn", parsed_output: FIELDS });
    const ocr = anthropicOcr({ apiKey: "test", model: "claude-opus-5-5" });

    const pdf = await ocr.extractInvoice({ bytes: Buffer.from("%PDF-1.4"), mime: "application/pdf" });
    expect(pdf).toEqual({ fields: FIELDS, simulated: false });
    const call = parse.mock.calls[0][0];
    expect(call.model).toBe("claude-opus-5-5");
    expect(call.output_config.effort).toBe("low");
    expect(call.output_config.format).toBeDefined();
    expect(call.messages[0].content[0]).toMatchObject({ type: "document", source: { type: "base64", media_type: "application/pdf", data: Buffer.from("%PDF-1.4").toString("base64") } });
    expect(call.messages[0].content[1].text).toMatch(/null for anything you cannot read/);

    await ocr.extractInvoice({ bytes: Buffer.from([1, 2, 3]), mime: "image/png" });
    expect(parse.mock.calls[1][0].messages[0].content[0]).toMatchObject({ type: "image", source: { media_type: "image/png" } });
  });

  it("rejects unsupported types without calling the model, and surfaces refusals and unparseable replies as errors", async () => {
    const { anthropicOcr } = await import("./anthropic-ocr");
    const ocr = anthropicOcr({ apiKey: "test" });
    await expect(ocr.extractInvoice({ bytes: Buffer.from("x"), mime: "image/svg+xml" })).rejects.toThrow(/PDF, PNG or JPEG/);
    expect(parse).not.toHaveBeenCalled();
    parse.mockResolvedValueOnce({ stop_reason: "refusal", parsed_output: null });
    await expect(ocr.extractInvoice({ bytes: Buffer.from("x"), mime: "application/pdf" })).rejects.toThrow(/could not be read/);
    parse.mockResolvedValueOnce({ stop_reason: "end_turn", parsed_output: null });
    await expect(ocr.extractInvoice({ bytes: Buffer.from("x"), mime: "application/pdf" })).rejects.toThrow(/could not be read/);
  });
});

describe("sandbox reading and gateway behaviour", () => {
  it("the simulated reader is deterministic, flagged as simulated, and invents no company details", async () => {
    const a = await mock.ocr.extractInvoice({ bytes: Buffer.from("same file"), mime: "application/pdf" });
    const b = await mock.ocr.extractInvoice({ bytes: Buffer.from("same file"), mime: "application/pdf" });
    const c = await mock.ocr.extractInvoice({ bytes: Buffer.from("other file"), mime: "application/pdf" });
    expect(a.simulated).toBe(true);
    expect(a.fields.invoiceNumber).toBe(b.fields.invoiceNumber);
    expect(a.fields.invoiceNumber).not.toBe(c.fields.invoiceNumber);
    expect(a.fields).toMatchObject({ sellerName: null, sellerGstin: null, buyerGstin: null, irn: null });
  });

  it("gets a longer timeout than other calls and is never retried (a repeat would cost money)", async () => {
    let calls = 0;
    const slow: Adapters = { ...mock, ocr: { extractInvoice: async () => { calls++; throw new Error("provider error"); } } };
    const g = harden(slow, { timeoutMs: 5, retries: 3, sleep: async () => {}, log: () => {} });
    await expect(g.ocr.extractInvoice({ bytes: Buffer.from("x"), mime: "application/pdf" })).rejects.toThrow("provider error");
    expect(calls).toBe(1);
    const hung: Adapters = { ...mock, ocr: { extractInvoice: () => new Promise((r) => setTimeout(() => r({ fields: FIELDS, simulated: false }), 30)) } };
    const g2 = harden(hung, { timeoutMs: 5, log: () => {} }); // 30 ms is past the default 5 ms but inside OCR's own allowance
    await expect(g2.ocr.extractInvoice({ bytes: Buffer.from("x"), mime: "application/pdf" })).resolves.toMatchObject({ simulated: false });
  });
});
