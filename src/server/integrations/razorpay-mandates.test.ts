import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { mandateStatus, parseRazorpayMandateWebhook, razorpayMandates, registrationLink } from "./razorpay-mandates";

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
/** Stub fetch that answers calls in order; an Error entry is thrown. */
const stub = (...answers: (Response | Error)[]) => {
  const f = vi.fn(async () => { const a = answers.shift(); if (!a) throw new Error("unexpected call"); if (a instanceof Error) throw a; return a; });
  return f as unknown as typeof fetch & typeof f;
};
const call = (f: ReturnType<typeof stub>, i = 0) => {
  const [url, init] = f.mock.calls[i] as unknown as [string, RequestInit];
  return { url, init, headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(init.body as string) : undefined };
};
const base = { keyId: "rzp_test_id", keySecret: "secret" };
const auth = `Basic ${Buffer.from("rzp_test_id:secret").toString("base64")}`;
const reg = { idempotencyKey: "mandate:1", holderName: "Acme Pvt Ltd", accountNumber: "1121431121541121", ifsc: "HDFC0000001", maxAmount: 5_000_000n };
const deb = { idempotencyKey: "nach:inv1:1", mandateRef: "cust_1:inv_1", amount: 123_456n, reference: "Invoice A-1" };
const token = { id: "token_1", method: "emandate", created_at: 10, recurring_details: { status: "confirmed", failure_reason: null } };
const timeout = new DOMException("timed out", "TimeoutError");

describe("register", () => {
  it("creates an e-mandate authorisation link and comes back pending", async () => {
    const f = stub(reply(200, { items: [] }), reply(200, { id: "inv_1", customer_id: "cust_1", status: "issued", short_url: "https://rzp.io/i/x" }));
    const r = await razorpayMandates({ ...base, fetch: f }).register(reg);
    expect(r).toEqual({ mandateRef: "cust_1:inv_1", status: "pending" });
    expect(call(f, 0).url).toMatch(/^https:\/\/api\.razorpay\.com\/v1\/invoices\?receipt=MV[0-9a-f]{30}$/);
    const c = call(f, 1);
    expect(c.url).toBe("https://api.razorpay.com/v1/subscription_registration/auth_links");
    expect(c.init.method).toBe("POST");
    expect(c.headers.authorization).toBe(auth);
    expect(c.body).toMatchObject({
      type: "link", amount: 0, currency: "INR", sms_notify: false, email_notify: false,
      customer: { name: "Acme Pvt Ltd" },
      subscription_registration: { method: "emandate", auth_type: "netbanking", max_amount: 5_000_000, bank_account: { beneficiary_name: "Acme Pvt Ltd", account_number: "1121431121541121", ifsc_code: "HDFC0000001" } },
    });
    expect(c.body.receipt).toBe(call(f, 0).url.split("=")[1]);
  });
  it("returns the existing link on a retry instead of making a second", async () => {
    const f1 = stub(reply(200, { items: [] }), reply(200, { id: "inv_1", customer_id: "cust_1", status: "issued" }));
    await razorpayMandates({ ...base, fetch: f1 }).register(reg);
    const receipt = call(f1, 1).body.receipt;
    const f = stub(reply(200, { items: [{ id: "inv_1", customer_id: "cust_1", receipt, status: "issued" }] }));
    expect(await razorpayMandates({ ...base, fetch: f }).register(reg)).toEqual({ mandateRef: "cust_1:inv_1", status: "pending" });
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("reports refused details as rejected, but outages and timeouts throw", async () => {
    const bad = await razorpayMandates({ ...base, fetch: stub(reply(200, { items: [] }), reply(400, { error: { code: "BAD_REQUEST_ERROR", description: "ifsc_code is invalid" } })) }).register(reg);
    expect(bad).toMatchObject({ status: "rejected", reason: "ifsc_code is invalid" });
    await expect(razorpayMandates({ ...base, fetch: stub(reply(200, { items: [] }), reply(401, { error: { code: "BAD_REQUEST_ERROR", description: "Authentication failed" } })) }).register(reg)).rejects.toThrow(/401/);
    await expect(razorpayMandates({ ...base, fetch: stub(reply(200, { items: [] }), reply(502, {})) }).register(reg)).rejects.toThrow(/502/);
    await expect(razorpayMandates({ ...base, fetch: stub(reply(200, { items: [] }), timeout) }).register(reg)).rejects.toThrow(/timed out/);
  });
  it("gives back the link the buyer opens", async () => {
    const f = stub(reply(200, { id: "inv_1", short_url: "https://rzp.io/i/x" }));
    expect(await registrationLink({ ...base, fetch: f }, "cust_1:inv_1")).toBe("https://rzp.io/i/x");
    expect(call(f).url).toBe("https://api.razorpay.com/v1/invoices/inv_1");
    await expect(registrationLink({ ...base, fetch: stub(reply(404, {})) }, "cust_1:inv_1")).rejects.toThrow(/404/);
  });
});

describe("debit", () => {
  it("creates an order, then a recurring payment on the confirmed token", async () => {
    const f = stub(
      reply(200, { items: [] }), reply(200, { id: "order_1" }),
      reply(200, { items: [{ ...token, id: "token_old", created_at: 1 }, token, { ...token, id: "token_bad", created_at: 99, recurring_details: { status: "rejected" } }] }),
      reply(200, { email: "a@b.in", contact: "+919999999999" }), reply(200, { razorpay_payment_id: "pay_1" }),
    );
    expect(await razorpayMandates({ ...base, fetch: f }).debit(deb)).toEqual({ debitRef: "pay_1", status: "processing" });
    const lookup = call(f, 0), order = call(f, 1), pay = call(f, 4);
    expect(lookup.url).toMatch(/\/v1\/orders\?receipt=MV[0-9a-f]{30}$/);
    expect(order.url).toBe("https://api.razorpay.com/v1/orders");
    expect(order.headers.authorization).toBe(auth);
    expect(order.body).toMatchObject({ amount: 123_456, currency: "INR", payment_capture: true, notes: { idempotency_key: "nach:inv1:1" } });
    expect(order.body.receipt).toBe(lookup.url.split("=")[1]);
    expect(call(f, 2).url).toBe("https://api.razorpay.com/v1/customers/cust_1/tokens");
    expect(pay.url).toBe("https://api.razorpay.com/v1/payments/create/recurring");
    expect(pay.init.method).toBe("POST");
    expect(pay.body).toMatchObject({ email: "a@b.in", contact: "+919999999999", amount: 123_456, currency: "INR", order_id: "order_1", customer_id: "cust_1", token: "token_1", recurring: true, notes: { idempotency_key: "nach:inv1:1" } });
  });
  it("a second call with the same key finds the first payment and does not debit again", async () => {
    // the receipt is a hash we do not know in advance, so the fake echoes back whatever receipt is asked for
    const g = vi.fn(async (url: string) => {
      if (url.includes("/orders?receipt=")) return reply(200, { items: [{ id: "order_1", receipt: url.split("=")[1] }] });
      if (url.endsWith("/orders/order_1/payments")) return reply(200, { items: [{ id: "pay_1", status: "captured", acquirer_data: { rrn: "RRN1" } }] });
      throw new Error(`unexpected ${url}`);
    }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
    const m = razorpayMandates({ ...base, fetch: g });
    const a = await m.debit(deb), b = await m.debit(deb);
    expect(a).toEqual({ debitRef: "pay_1", status: "succeeded", utr: "RRN1" });
    expect(b).toEqual(a);
    const posts = g.mock.calls.filter(([, init]: unknown[]) => (init as RequestInit).method === "POST");
    expect(posts).toHaveLength(0);
  });
  it("an existing order with no payment yet is reused, not recreated", async () => {
    const g = vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes("/orders?receipt=")) return reply(200, { items: [{ id: "order_1", receipt: url.split("=")[1] }] });
      if (url.endsWith("/orders/order_1/payments")) return reply(200, { items: [] });
      if (url.endsWith("/tokens")) return reply(200, { items: [token] });
      if (url.endsWith("/customers/cust_1")) return reply(200, { email: "a@b.in", contact: "1" });
      if (url.endsWith("/payments/create/recurring")) return reply(200, { razorpay_payment_id: "pay_2" });
      throw new Error(`unexpected ${init.method} ${url}`);
    }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
    expect(await razorpayMandates({ ...base, fetch: g }).debit(deb)).toEqual({ debitRef: "pay_2", status: "processing" });
    expect(g.mock.calls.some(([u]: unknown[]) => String(u).endsWith("/v1/orders"))).toBe(false);
  });
  it("maps payment statuses", async () => {
    const g = async (p: unknown) => {
      const f = vi.fn(async (url: string) => url.includes("/orders?receipt=") ? reply(200, { items: [{ id: "order_1", receipt: url.split("=")[1] }] }) : reply(200, { items: [p] })) as unknown as typeof fetch;
      return razorpayMandates({ ...base, fetch: f }).debit(deb);
    };
    expect(await g({ id: "p", status: "failed", error_description: "Insufficient funds" })).toEqual({ debitRef: "p", status: "failed", reason: "Insufficient funds" });
    expect(await g({ id: "p", status: "authorized" })).toEqual({ debitRef: "p", status: "processing" });
    expect(await g({ id: "p", status: "created" })).toEqual({ debitRef: "p", status: "processing" });
    expect(await g({ id: "p", status: "captured" })).toEqual({ debitRef: "p", status: "succeeded" });
  });
  it("a refusal of the request is a failed debit; an outage, timeout or missing token throws", async () => {
    const run = (...a: (Response | Error)[]) => razorpayMandates({ ...base, fetch: stub(reply(200, { items: [] }), reply(200, { id: "order_1" }), ...a) }).debit(deb);
    expect(await run(reply(200, { items: [token] }), reply(200, {}), reply(400, { error: { code: "BAD_REQUEST_ERROR", description: "Amount exceeds maximum amount allowed." } })))
      .toEqual({ debitRef: "order_1", status: "failed", reason: "Amount exceeds maximum amount allowed." });
    await expect(run(reply(200, { items: [token] }), reply(200, {}), reply(500, {}))).rejects.toThrow(/500/);
    await expect(run(reply(200, { items: [token] }), reply(200, {}), timeout)).rejects.toThrow(/timed out/);
    await expect(run(reply(200, { items: [{ ...token, recurring_details: { status: "initiated" } }] }))).rejects.toThrow(/no confirmed token/);
    await expect(razorpayMandates({ ...base, fetch: stub(reply(500, {})) }).debit(deb)).rejects.toThrow(/order lookup failed \(500/);
  });
});

describe("cancel and status", () => {
  it("deletes the live tokens", async () => {
    const f = stub(reply(200, { items: [token, { ...token, id: "token_2", recurring_details: { status: "cancelled" } }] }), reply(200, { deleted: true }));
    await razorpayMandates({ ...base, fetch: f }).cancel("cust_1:inv_1");
    expect(f).toHaveBeenCalledTimes(2);
    expect(call(f, 1).url).toBe("https://api.razorpay.com/v1/customers/cust_1/tokens/token_1");
    expect(call(f, 1).init.method).toBe("DELETE");
    expect(call(f, 1).headers.authorization).toBe(auth);
  });
  it("closes the link when the buyer never authorised, and throws when a delete fails", async () => {
    const f = stub(reply(200, { items: [] }), reply(200, {}));
    await razorpayMandates({ ...base, fetch: f }).cancel("cust_1:inv_1");
    expect(call(f, 1).url).toBe("https://api.razorpay.com/v1/invoices/inv_1/cancel");
    await expect(razorpayMandates({ ...base, fetch: stub(reply(200, { items: [token] }), reply(500, {})) }).cancel("cust_1:inv_1")).rejects.toThrow(/500/);
  });
  it("reads where a mandate stands", async () => {
    const st = (...items: unknown[]) => mandateStatus({ ...base, fetch: stub(reply(200, { items })) }, "cust_1:inv_1");
    expect(await st(token)).toEqual({ status: "active" });
    expect(await st({ ...token, recurring_details: { status: "rejected", failure_reason: "Rejected by bank" } })).toEqual({ status: "rejected", reason: "Rejected by bank" });
    expect(await st({ ...token, recurring_details: { status: "cancelled" } })).toEqual({ status: "cancelled" });
    expect(await st({ ...token, recurring_details: { status: "initiated" } })).toEqual({ status: "pending" });
    expect(await st()).toEqual({ status: "pending" });
  });
  it("rejects a malformed reference", async () => {
    await expect(razorpayMandates({ ...base, fetch: stub() }).cancel("nonsense")).rejects.toThrow(/malformed/);
  });
});

describe("webhook", () => {
  const secret = "whsec";
  const sign = (b: string) => createHmac("sha256", secret).update(b).digest("hex");
  const parse = (o: unknown) => { const raw = JSON.stringify(o); return parseRazorpayMandateWebhook(raw, sign(raw), secret); };
  const tokenEvent = (event: string, status: string, failure_reason: string | null = null) => ({ event, payload: { token: { entity: { id: "token_1", recurring_details: { status, failure_reason } } } } });
  const payEvent = (event: string, entity: object) => ({ event, payload: { payment: { entity: { id: "pay_1", ...entity } } } });

  it("maps token events", () => {
    expect(parse(tokenEvent("token.confirmed", "confirmed"))).toEqual({ type: "token", tokenId: "token_1", status: "active" });
    expect(parse(tokenEvent("token.rejected", "rejected", "Rejected by bank"))).toEqual({ type: "token", tokenId: "token_1", status: "rejected", reason: "Rejected by bank" });
    expect(parse(tokenEvent("token.cancelled", "cancelled"))).toEqual({ type: "token", tokenId: "token_1", status: "cancelled" });
    expect(parse(tokenEvent("token.paused", "paused"))).toBeNull();
  });
  it("maps debit payments by the idempotency key in their notes", () => {
    expect(parse(payEvent("payment.captured", { notes: { idempotency_key: "nach:i:1" }, acquirer_data: { rrn: "R1" } })))
      .toEqual({ type: "debit", idempotencyKey: "nach:i:1", status: "succeeded", providerRef: "pay_1", utr: "R1" });
    expect(parse(payEvent("payment.failed", { notes: { idempotency_key: "nach:i:1" }, error_description: "Insufficient funds" })))
      .toEqual({ type: "debit", idempotencyKey: "nach:i:1", status: "failed", providerRef: "pay_1", reason: "Insufficient funds" });
    expect(parse(payEvent("payment.captured", { notes: [] }))).toBeNull(); // not one of our debits
  });
  it("rejects a tampered body, a wrong or missing signature, and no secret", () => {
    const raw = JSON.stringify(tokenEvent("token.confirmed", "confirmed"));
    const sig = sign(raw);
    expect(() => parseRazorpayMandateWebhook(raw.replace("token_1", "token_2"), sig, secret)).toThrow("invalid signature");
    expect(() => parseRazorpayMandateWebhook(raw, sign("other"), secret)).toThrow("invalid signature");
    expect(() => parseRazorpayMandateWebhook(raw, "zz", secret)).toThrow("invalid signature");
    expect(() => parseRazorpayMandateWebhook(raw, null, secret)).toThrow("invalid signature");
    expect(() => parseRazorpayMandateWebhook(raw, sig, "")).toThrow("invalid signature");
  });
  it("ignores an unknown event", () => {
    expect(parse({ event: "order.paid", payload: {} })).toBeNull();
  });
});
