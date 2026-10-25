import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { parseWhatsappWebhook, toWhatsappId, verifyWhatsappSignature, whatsappNotify } from "./whatsapp";
import { mock } from "./mock";

const msg = { channel: "whatsapp" as const, to: "+91 98765-43210", template: "disbursed", data: { invoiceNumber: "INV-1", amount: "₹1,000.00" }, body: JSON.stringify(["₹1,000.00", "INV-1"]) };
const ok = () => vi.fn(async () => new Response(JSON.stringify({ messaging_product: "whatsapp", contacts: [{ input: "919876543210", wa_id: "919876543210" }], messages: [{ id: "wamid.XYZ" }] }), { status: 200 }));
const adapter = (f: unknown, extra = {}) => whatsappNotify(mock.notify, { phoneNumberId: "1234", accessToken: "TOKEN", fetch: f as typeof fetch, ...extra });
const sent = (f: ReturnType<typeof ok>) => { const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]; return { url, init, body: JSON.parse(init.body as string) }; };
const reply = (status: number, body: unknown) => adapter(vi.fn(async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status }))).send(msg);

describe("WhatsApp adapter", () => {
  it("posts a template message with positional body parameters and returns the message id", async () => {
    const f = ok();
    expect(await adapter(f).send(msg)).toEqual({ providerRef: "wamid.XYZ" });
    const { url, init, body } = sent(f);
    expect(url).toBe("https://graph.facebook.com/v26.0/1234/messages");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ authorization: "Bearer TOKEN", "content-type": "application/json" });
    expect(body).toEqual({
      messaging_product: "whatsapp", recipient_type: "individual", to: "919876543210", type: "template",
      template: { name: "marichi_disbursed", language: { code: "en" }, components: [{ type: "body", parameters: [{ type: "text", text: "₹1,000.00" }, { type: "text", text: "INV-1" }] }] },
    });
  });
  it("honours the api version, reads parameters from data when the body is not JSON, and cleans values", async () => {
    const f = ok();
    await adapter(f, { apiVersion: "v99.0" }).send({ ...msg, body: "not json", data: { amount: "₹5\nx\t    y", invoiceNumber: "" } });
    const { url, body } = sent(f);
    expect(url).toContain("/v99.0/");
    expect(body.template.components[0].parameters.map((p: { text: string }) => p.text)).toEqual(["₹5 x   y", "-"]);
  });
  it("normalises numbers and rejects bad ones before calling", async () => {
    for (const n of ["+919876543210", "91 98765 43210", "(+91) 98765-43210", "919876543210"]) expect(toWhatsappId(n)).toBe("919876543210");
    expect(toWhatsappId("+1 415 555 0123")).toBe("14155550123");
    const f = ok();
    for (const bad of ["12345", "0098765432101", "abc", "", "+0123456789012"]) await expect(adapter(f).send({ ...msg, to: bad })).rejects.toMatchObject({ permanent: true });
    expect(f).not.toHaveBeenCalled();
  });
  it("a template with no WhatsApp variant is refused for good", async () => {
    await expect(adapter(ok()).send({ ...msg, template: "payment_received" })).rejects.toMatchObject({ permanent: true });
  });
  it("maps errors: recipient/parameter problems are final, token/throttle/server problems are retried", async () => {
    const err = (code: number) => ({ error: { message: "m", type: "OAuthException", code, error_data: { messaging_product: "whatsapp", details: "the details" }, fbtrace_id: "x" } });
    for (const code of [131026, 132000, 131047, 100]) await expect(reply(400, err(code))).rejects.toMatchObject({ permanent: true, message: expect.stringContaining(`(${code}): the details`) });
    for (const [status, code] of [[401, 190], [429, 130429], [500, 131000], [503, 131016], [400, 132001]] as const) {
      const e = await reply(status, err(code)).catch((x) => x);
      expect(e.message).toContain(`(${code})`);
      expect(e.permanent).toBeUndefined();
    }
    await expect(reply(502, "<html>")).rejects.toThrow(/502/);
    await expect(reply(200, { messages: [] })).rejects.toThrow(/no message id/);
    await expect(reply(200, { error: { code: 131026, message: "x" } })).rejects.toMatchObject({ permanent: true }); // an error body is an error even on 200
  });
  it("network errors propagate and other channels go to the fallback", async () => {
    await expect(adapter(vi.fn(async () => { throw new Error("ECONNRESET"); })).send(msg)).rejects.toThrow(/ECONNRESET/);
    const f = ok();
    expect((await adapter(f).send({ channel: "sms", to: "+919876543210", template: "t", data: {}, body: "B" }))?.providerRef).toMatch(/^MOCKMSG-/);
    expect(f).not.toHaveBeenCalled();
  });
});

const hook = (statuses: unknown[]) => ({ object: "whatsapp_business_account", entry: [{ id: "W", changes: [{ field: "messages", value: { messaging_product: "whatsapp", statuses } }] }] });

describe("WhatsApp webhook", () => {
  it("maps delivered, read and failed with their time; skips sent, played and junk", () => {
    const r = parseWhatsappWebhook(hook([
      { id: "w1", status: "sent", timestamp: "1739321020" },
      { id: "w1", status: "delivered", timestamp: "1739321024" },
      { id: "w2", status: "read", timestamp: "1739321030" },
      { id: "w3", status: "failed", timestamp: "1739321031", errors: [{ code: 131026, title: "x" }] },
      { id: "w4", status: "played", timestamp: "1" },
      { status: "delivered" }, { id: "w5", status: "weird" }, null,
    ]));
    expect(r).toEqual([
      { providerRef: "w1", status: "delivered", at: new Date(1739321024_000) },
      { providerRef: "w2", status: "read", at: new Date(1739321030_000) },
      { providerRef: "w3", status: "failed", at: new Date(1739321031_000) },
    ]);
    expect(parseWhatsappWebhook(hook([{ id: "w6", status: "read" }]))[0].at).toBeUndefined();
  });
  it("gives nothing for incoming messages or garbage", () => {
    expect(parseWhatsappWebhook({ entry: [{ changes: [{ field: "messages", value: { messages: [{ id: "m" }] } }] }] })).toEqual([]);
    for (const x of [null, undefined, "x", 5, {}, { entry: "no" }, { entry: [null, { changes: 3 }] }]) expect(parseWhatsappWebhook(x)).toEqual([]);
  });
  it("checks X-Hub-Signature-256 against the raw body and the app secret", () => {
    const raw = JSON.stringify(hook([]));
    const sig = "sha256=" + createHmac("sha256", "SECRET").update(raw).digest("hex");
    expect(verifyWhatsappSignature(raw, sig, "SECRET")).toBe(true);
    expect(verifyWhatsappSignature(raw + " ", sig, "SECRET")).toBe(false);
    expect(verifyWhatsappSignature(raw, sig, "OTHER")).toBe(false);
    expect(verifyWhatsappSignature(raw, sig, "")).toBe(false);
    expect(verifyWhatsappSignature(raw, null, "SECRET")).toBe(false);
    expect(verifyWhatsappSignature(raw, sig.replace("sha256=", ""), "SECRET")).toBe(false);
    expect(verifyWhatsappSignature(raw, "sha256=zz", "SECRET")).toBe(false);
    expect(verifyWhatsappSignature(raw, "sha256=abcd", "SECRET")).toBe(false);
  });
});
