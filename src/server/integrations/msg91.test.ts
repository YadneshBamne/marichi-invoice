import { describe, expect, it, vi } from "vitest";
import { msg91Notify, parseMsg91Report, toMsisdn } from "./msg91";
import { mock } from "./mock";

const sms = { channel: "sms" as const, to: "+91 98765-43210", template: "disbursed", data: { invoiceNumber: "INV-1", amount: "₹1,000.00" }, body: "Marichi: Rs. 1,000.00 has been paid to your bank account for invoice INV-1.", dltTemplateId: "tpl_1" };
const ok = () => vi.fn(async () => new Response(JSON.stringify({ type: "success", message: "req_abc" }), { status: 200 }));
const adapter = (f: unknown) => msg91Notify(mock.notify, { authKey: "K", senderId: "MARICH", fetch: f as typeof fetch });
const sent = (f: ReturnType<typeof ok>) => { const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]; return { url, init, body: JSON.parse(init.body as string) }; };

describe("MSG91 SMS adapter", () => {
  it("posts template id and variables with the authkey header and returns the request id", async () => {
    const f = ok();
    expect(await adapter(f).send(sms)).toEqual({ providerRef: "req_abc" });
    const { url, init, body } = sent(f);
    expect(url).toBe("https://control.msg91.com/api/v5/flow");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authkey).toBe("K");
    // variables are read back from the rendered text, so they match what the user sees (Rs., not the rupee sign)
    expect(body).toEqual({ template_id: "tpl_1", sender: "MARICH", short_url: "0", recipients: [{ mobiles: "919876543210", amount: "Rs. 1,000.00", invoiceNumber: "INV-1" }] });
  });
  it("gets the variables from the body when data is empty (retries, OTP) and from data when the wording is unknown", async () => {
    const f = ok();
    await adapter(f).send({ ...sms, template: "phone_otp", data: {}, body: "Marichi: 123456 is your verification code. It expires in 10 minutes. Do not share it." });
    expect(sent(f).body.recipients).toEqual([{ mobiles: "919876543210", code: "123456" }]);
    const g = ok();
    await adapter(g).send({ ...sms, template: "unknown", data: { a: "₹5\nx" }, body: "whatever" });
    expect(sent(g).body.recipients).toEqual([{ mobiles: "919876543210", a: "Rs.5 x" }]);
  });
  it("normalises Indian numbers and rejects anything else before calling", async () => {
    for (const n of ["9876543210", "+919876543210", "919876543210", "09876543210", "98765 43210"]) expect(toMsisdn(n)).toBe("919876543210");
    const f = ok();
    for (const bad of ["12345", "+14155550123", "5876543210", "98765432101", "abc", ""]) await expect(adapter(f).send({ ...sms, to: bad })).rejects.toThrow(/valid Indian mobile/);
    expect(f).not.toHaveBeenCalled();
  });
  it("leaves email to the fallback port", async () => {
    const f = ok();
    const r = await adapter(f).send({ channel: "email", to: "a@b.com", template: "t", data: {}, subject: "S", body: "B" });
    expect(r?.providerRef).toMatch(/^MOCKMSG-/);
    expect(f).not.toHaveBeenCalled();
  });
  it("throws on non-2xx, an error body, a 201 code, a garbage body or a missing template id", async () => {
    const reply = (status: number, body: string) => adapter(vi.fn(async () => new Response(body, { status }))).send(sms);
    await expect(reply(401, '{"errors":"Unauthorized","code":"401"}')).rejects.toThrow(/401/);
    await expect(reply(200, '{"type":"error","message":"flow id missing"}')).rejects.toThrow(/flow id missing/);
    await expect(reply(200, '{"type":"success","message":"x","code":"201"}')).rejects.toThrow(/failed/);
    await expect(reply(200, "<html>")).rejects.toThrow(/failed/);
    await expect(adapter(ok()).send({ ...sms, dltTemplateId: undefined })).rejects.toThrow(/template id/);
  });
  it("network errors propagate", async () => {
    await expect(adapter(vi.fn(async () => { throw new Error("ECONNRESET"); })).send(sms)).rejects.toThrow(/ECONNRESET/);
  });
});

describe("MSG91 delivery reports", () => {
  it("maps final statuses and ignores the rest", () => {
    expect(parseMsg91Report({ requestId: "r1", status: "1", eventName: "delivered" })).toEqual({ providerRef: "r1", status: "delivered" });
    expect(parseMsg91Report({ requestId: "r1", status: 1 })).toEqual({ providerRef: "r1", status: "delivered" });
    for (const s of ["2", "9", "16", "17", "20", "25"]) expect(parseMsg91Report({ requestId: "r2", status: s })).toEqual({ providerRef: "r2", status: "failed" });
    expect(parseMsg91Report({ requestId: "r3", status: "0" })).toBeNull(); // sent, not final
    expect(parseMsg91Report({ status: "1" })).toBeNull();
    expect(parseMsg91Report({ requestId: "r4" })).toBeNull();
    expect(parseMsg91Report(null)).toBeNull();
  });
});
