import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { digioEsign, parseDigioWebhook } from "./digio";

const pdf = Buffer.from("%PDF-1.4 test");
const read = async () => ({ bytes: pdf });
const req = { idempotencyKey: "agr-1", documentRef: "abc.pdf", signer: "seller@x.com" };
const mk = (f: unknown, env: "sandbox" | "production" = "sandbox") =>
  digioEsign({ clientId: "cid", clientSecret: "sec", env, readDocument: read, fetch: f as typeof fetch });

describe("Digio e-sign adapter", () => {
  it("uploads the PDF as base64 with basic auth and returns the document id", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ id: "DID123", agreement_status: "requested" }), { status: 200 }));
    expect(await mk(f).request(req)).toEqual({ requestId: "DID123" });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://ext.digio.in:444/v2/client/document/uploadpdf");
    expect(init.method).toBe("POST");
    const h = init.headers as Record<string, string>;
    expect(h.authorization).toBe("Basic " + Buffer.from("cid:sec").toString("base64"));
    expect(h["content-type"]).toBe("application/json");
    const body = JSON.parse(init.body as string);
    expect(body.file_data).toBe(pdf.toString("base64"));
    expect(body.file_name).toBe("abc.pdf");
    expect(body.signers).toEqual([expect.objectContaining({ identifier: "seller@x.com" })]);
    expect(body.notify_signers).toBe(true);
  });
  it("uses the production host when asked", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ id: "D" }), { status: 200 }));
    await mk(f, "production").request(req);
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe("https://api.digio.in/v2/client/document/uploadpdf");
  });
  it("sends the idempotency key as Digio's unique callback id, so a retry gets the same document back", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ id: "DID123" }), { status: 200 }));
    const a = await mk(f).request(req);
    const b = await mk(f).request(req);
    expect(b).toEqual(a);
    const ids = f.mock.calls.map((c) => JSON.parse((c as unknown as [string, RequestInit])[1].body as string).callback);
    expect(ids).toEqual(["agr-1", "agr-1"]);
  });
  it("throws on a non-2xx answer with Digio's error code, and when no id comes back", async () => {
    const bad = vi.fn(async () => new Response(JSON.stringify({ code: "REQUEST_VALIDATION_FAILED", message: "Request Validation Failed" }), { status: 400 }));
    await expect(mk(bad).request(req)).rejects.toThrow(/400.*REQUEST_VALIDATION_FAILED/);
    const down = vi.fn(async () => new Response("gateway down", { status: 502 }));
    await expect(mk(down).request(req)).rejects.toThrow(/502/);
    const empty = vi.fn(async () => new Response("{}", { status: 200 }));
    await expect(mk(empty).request(req)).rejects.toThrow(/no document id/);
  });
});

const secret = "whsec";
const sign = (body: string) => createHmac("sha256", secret).update(body).digest("hex");
const event = (name: string, parties: unknown[] = [{ identifier: "seller@x.com", status: "signed" }]) =>
  JSON.stringify({ id: "WHN1", created_at: 1, event: name, entities: ["document"], payload: { document: { id: "DID123", signing_parties: parties } } });

describe("Digio webhook", () => {
  it("accepts a signed event with a valid checksum (header object or Headers)", () => {
    const body = event("doc.signed");
    const want = { requestId: "DID123", outcome: "signed", signer: { email: "seller@x.com" } };
    expect(parseDigioWebhook(body, { "X-Digio-Checksum": sign(body) }, secret)).toEqual(want);
    expect(parseDigioWebhook(body, new Headers({ "x-digio-checksum": sign(body) }), secret)).toEqual(want);
  });
  it("maps a failed or rejected signing to failed", () => {
    for (const e of ["doc.sign.failed", "doc.sign.rejected"]) {
      const body = event(e, []);
      expect(parseDigioWebhook(body, { "x-digio-checksum": sign(body) }, secret)).toEqual({ requestId: "DID123", outcome: "failed", signer: undefined });
    }
  });
  it("rejects a tampered body, a wrong or missing checksum, and an empty secret", () => {
    const body = event("doc.signed");
    const sig = sign(body);
    expect(() => parseDigioWebhook(body.replace("DID123", "DID999"), { "x-digio-checksum": sig }, secret)).toThrow(/checksum/);
    expect(() => parseDigioWebhook(body, { "x-digio-checksum": "00".repeat(32) }, secret)).toThrow(/checksum/);
    expect(() => parseDigioWebhook(body, {}, secret)).toThrow(/checksum/);
    expect(() => parseDigioWebhook(body, { "x-digio-checksum": createHmac("sha256", "").update(body).digest("hex") }, "")).toThrow(/checksum/);
  });
  it("returns null for events it does not act on, so the route can still answer 200", () => {
    const body = event("doc.expired");
    expect(parseDigioWebhook(body, { "x-digio-checksum": sign(body) }, secret)).toBeNull();
  });
});
