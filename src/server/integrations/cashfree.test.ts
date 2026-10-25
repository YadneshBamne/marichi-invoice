import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { cashfreeKyc, cashfreePayments, parseCashfreeCredit, verifyCashfreeWebhookSignature } from "./cashfree";
import { mock } from "./mock";

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
/** Stub fetch that answers calls in order; a function entry is used to throw. */
const stub = (...answers: (Response | Error)[]) => {
  const f = vi.fn(async () => { const a = answers.shift(); if (!a) throw new Error("unexpected call"); if (a instanceof Error) throw a; return a; });
  return f as unknown as typeof fetch & typeof f;
};
const call = (f: ReturnType<typeof stub>, i = 0) => {
  const [url, init] = f.mock.calls[i] as unknown as [string, RequestInit];
  return { url, init, headers: init.headers as Record<string, string>, body: init.body as string | undefined };
};
const creds = { clientId: "id", clientSecret: "secret", env: "sandbox" as const };
const timeout = new DOMException("timed out", "TimeoutError");

describe("Cashfree KYC", () => {
  it("checks a PAN and name, sandbox URL, auth headers", async () => {
    const f = stub(reply(200, { valid: true, pan_status: "VALID", name_match_result: "DIRECT_MATCH" }));
    const k = cashfreeKyc(mock.kyc, { ...creds, fetch: f });
    expect(await k.verifyTaxId("abcpv1234d", "Acme Pvt. Ltd,")).toEqual({ valid: true, nameMatch: true });
    const c = call(f);
    expect(c.url).toBe("https://sandbox.cashfree.com/verification/pan");
    expect(c.init.method).toBe("POST");
    expect(c.headers).toMatchObject({ "x-client-id": "id", "x-client-secret": "secret", "content-type": "application/json" });
    expect(JSON.parse(c.body!)).toEqual({ pan: "ABCPV1234D", name: "Acme Pvt. Ltd" }); // the comma is not allowed by Cashfree
  });
  it("uses the production host when asked", async () => {
    const f = stub(reply(200, { valid: true }));
    await cashfreeKyc(mock.kyc, { ...creds, env: "production", fetch: f }).verifyTaxId("ABCPV1234D", "A");
    expect(call(f).url).toBe("https://api.cashfree.com/verification/pan");
  });
  it("maps invalid PAN, poor name match and a deactivated PAN", async () => {
    const k = (b: unknown) => cashfreeKyc(mock.kyc, { ...creds, fetch: stub(reply(200, b)) });
    expect(await k({ valid: false, name_match_score: 0, name_match_result: "-" }).verifyTaxId("ABCPV1234D", "X")).toEqual({ valid: false, nameMatch: false });
    expect(await k({ valid: true, pan_status: "VALID", name_match_result: "POOR_PARTIAL_MATCH" }).verifyTaxId("ABCPV1234D", "X")).toEqual({ valid: true, nameMatch: false });
    expect(await k({ valid: true, pan_status: "DEACTIVATED", name_match_result: "DIRECT_MATCH" }).verifyTaxId("ABCPV1234D", "X")).toEqual({ valid: false, nameMatch: false });
  });
  it("treats a malformed PAN as invalid but an outage, bad credentials or timeout as errors", async () => {
    const run = (a: Response | Error) => cashfreeKyc(mock.kyc, { ...creds, fetch: stub(a) }).verifyTaxId("ABCPV1234D", "X");
    expect(await run(reply(400, { type: "validation_error", code: "pan_length_short", message: "short" }))).toEqual({ valid: false, nameMatch: false });
    await expect(run(reply(401, { code: "authentication_failed", message: "bad keys" }))).rejects.toThrow(/401 authentication_failed/);
    await expect(run(reply(502, { code: "verification_failed", message: "source down" }))).rejects.toThrow(/502/);
    await expect(run(timeout)).rejects.toThrow(/timed out/);
  });
  it("verifies a bank account with name match", async () => {
    const f = stub(reply(200, { account_status: "VALID", account_status_code: "ACCOUNT_IS_VALID", name_match_result: "GOOD_PARTIAL_MATCH", name_match_score: "90.00" }));
    expect(await cashfreeKyc(mock.kyc, { ...creds, fetch: f }).verifyBankAccount("26291800001191", "YESB0000001", "John Doe")).toEqual({ exists: true, nameMatch: true });
    const c = call(f);
    expect(c.url).toBe("https://sandbox.cashfree.com/verification/bank-account/sync");
    expect(c.init.method).toBe("POST");
    expect(JSON.parse(c.body!)).toEqual({ bank_account: "26291800001191", ifsc: "YESB0000001", name: "John Doe" });
  });
  it("maps an invalid account, a blocked account, bad IFSC format, and bank-side 422 as an error", async () => {
    const run = (a: Response) => cashfreeKyc(mock.kyc, { ...creds, fetch: stub(a) }).verifyBankAccount("1", "YESB0000001", "X");
    expect(await run(reply(200, { account_status: "INVALID", account_status_code: "INVALID_ACCOUNT_FAIL", name_match_result: null }))).toEqual({ exists: false, nameMatch: false });
    expect(await run(reply(200, { account_status: "INVALID", account_status_code: "ACCOUNT_BLOCKED" }))).toEqual({ exists: false, nameMatch: false });
    expect(await run(reply(400, { type: "validation_error", code: "ifsc_value_invalid", message: "bad" }))).toEqual({ exists: false, nameMatch: false });
    await expect(run(reply(422, { type: "validation_error", code: "npci_unavailable", message: "down" }))).rejects.toThrow(/npci_unavailable/);
  });
  it("leaves AML screening to the fallback port", async () => {
    const f = stub();
    const aml = vi.fn(async () => ({ score: 99, hit: true }));
    const k = cashfreeKyc({ ...mock.kyc, screenAml: aml }, { ...creds, fetch: f });
    expect(await k.screenAml("Someone")).toEqual({ score: 99, hit: true });
    expect(f).not.toHaveBeenCalled();
    const down = cashfreeKyc({ ...mock.kyc, screenAml: async () => { throw new Error("aml down"); } }, { ...creds, fetch: f });
    await expect(down.screenAml("x")).rejects.toThrow("aml down"); // still fail-closed
  });
});

describe("Cashfree payments: payout", () => {
  const p = { idempotencyKey: "disb-1:0", amount: 123_450n, ifsc: "YESB0000001", account: "026291800001191", rail: "IMPS" as const };

  it("posts a transfer with an exact decimal amount and the mapped rail", async () => {
    const f = stub(reply(200, { transfer_id: "x", cf_transfer_id: "9", status: "RECEIVED" }));
    const pay = cashfreePayments(mock.payments, { ...creds, fetch: f });
    const r = await pay.payout({ ...p, beneficiaryName: "Acme Traders" } as typeof p);
    const c = call(f);
    expect(c.url).toBe("https://sandbox.cashfree.com/payout/transfers");
    expect(c.init.method).toBe("POST");
    expect(c.headers).toMatchObject({ "x-client-id": "id", "x-client-secret": "secret", "x-api-version": "2024-01-01" });
    expect(c.body).toContain('"transfer_amount":1234.50,'); // literal, never a float
    const b = JSON.parse(c.body!);
    expect(b).toMatchObject({ transfer_currency: "INR", transfer_mode: "imps", beneficiary_details: { beneficiary_name: "Acme Traders", beneficiary_instrument_details: { bank_account_number: p.account, bank_ifsc: p.ifsc } } });
    expect(b.transfer_id).toMatch(/^MV_[0-9a-f]{36}$/);
    expect(r).toEqual({ bankRef: b.transfer_id, status: "processing" }); // bankRef is our transfer id, which payoutStatus looks up
    // same key => same transfer id; a new attempt key => a new one
    const f2 = stub(reply(200, { status: "RECEIVED" }), reply(200, { status: "RECEIVED" }));
    const pay2 = cashfreePayments(mock.payments, { ...creds, fetch: f2 });
    await pay2.payout(p); await pay2.payout({ ...p, idempotencyKey: "disb-1:1", rail: "NEFT" });
    expect(JSON.parse(call(f2, 0).body!).transfer_id).toBe(b.transfer_id);
    expect(JSON.parse(call(f2, 1).body!)).toMatchObject({ transfer_mode: "neft" });
    expect(JSON.parse(call(f2, 1).body!).transfer_id).not.toBe(b.transfer_id);
  });
  it("maps success, failure and pending, with the reason on failure", async () => {
    const run = async (j: unknown) => cashfreePayments(mock.payments, { ...creds, fetch: stub(reply(200, j)) }).payout({ ...p, rail: "RTGS" });
    const ref = expect.stringMatching(/^MV_/);
    expect(await run({ transfer_id: "t", status: "SUCCESS", transfer_utr: "U1" })).toEqual({ bankRef: ref, status: "succeeded" });
    expect(await run({ transfer_id: "t", status: "FAILED", status_code: "IMPS_MODE_FAIL", status_description: "IMPS failed" })).toEqual({ bankRef: ref, status: "failed", reason: "IMPS failed" });
    expect(await run({ transfer_id: "t", status: "REVERSED", status_code: "BENE_NAME_DIFFERS" })).toMatchObject({ status: "failed", reason: "BENE_NAME_DIFFERS" });
    for (const s of ["RECEIVED", "PENDING", "QUEUED", "APPROVAL_PENDING", "VALIDATION_PENDING"]) expect(await run({ transfer_id: "t", status: s })).toMatchObject({ status: "processing" });
  });
  it("refuses a rail Cashfree does not run without calling out", async () => {
    const f = stub();
    await expect(cashfreePayments(mock.payments, { ...creds, fetch: f }).payout({ ...p, rail: "ZIPSS" })).rejects.toThrow(/ZIPSS/);
    expect(f).not.toHaveBeenCalled();
  });
  it("after a timeout or 5xx, looks the transfer up by id instead of sending a second one", async () => {
    for (const first of [timeout, reply(500, { code: "internal_server_error", message: "oops" })]) {
      const f = stub(first, reply(200, { transfer_id: "t", status: "SUCCESS" }));
      expect(await cashfreePayments(mock.payments, { ...creds, fetch: f }).payout(p)).toEqual({ bankRef: JSON.parse(call(f, 0).body!).transfer_id, status: "succeeded" });
      expect(f).toHaveBeenCalledTimes(2);
      const g = call(f, 1);
      expect(g.init.method).toBe("GET");
      expect(g.url).toBe(`https://sandbox.cashfree.com/payout/transfers?transfer_id=${JSON.parse(call(f, 0).body!).transfer_id}`);
    }
  });
  it("throws when the outcome is unknown (so it stays processing) and fails on a plain 400", async () => {
    const notFound = reply(404, { code: "transfer_id_not_found", message: "none" });
    await expect(cashfreePayments(mock.payments, { ...creds, fetch: stub(timeout, timeout) }).payout(p)).rejects.toThrow(/timed out/);
    await expect(cashfreePayments(mock.payments, { ...creds, fetch: stub(reply(500, { code: "internal_server_error", message: "x" }), notFound) }).payout(p)).rejects.toThrow(/500/);
    await expect(cashfreePayments(mock.payments, { ...creds, fetch: stub(reply(403, { code: "apis_not_enabled", message: "x" }), notFound) }).payout(p)).rejects.toThrow(/apis_not_enabled/);
    const bad = await cashfreePayments(mock.payments, { ...creds, fetch: stub(reply(400, { code: "beneficiary_details.bank_ifsc_invalid", message: "ifsc invalid" }), notFound) }).payout(p);
    expect(bad).toMatchObject({ status: "failed", reason: "ifsc invalid" });
  });
  it("reads payout status by transfer id", async () => {
    const f = stub(reply(200, { status: "SUCCESS" }), reply(200, { status: "REJECTED" }), reply(200, { status: "PENDING" }), reply(404, { code: "transfer_id_not_found", message: "none" }));
    const pay = cashfreePayments(mock.payments, { ...creds, fetch: f });
    expect(await pay.payoutStatus("MV_abc")).toBe("succeeded");
    expect(await pay.payoutStatus("MV_abc")).toBe("failed");
    expect(await pay.payoutStatus("MV_abc")).toBe("processing");
    await expect(pay.payoutStatus("MV_abc")).rejects.toThrow(/404/);
    const c = call(f);
    expect(c.url).toBe("https://sandbox.cashfree.com/payout/transfers?transfer_id=MV_abc");
    expect(c.init.method).toBe("GET");
    expect(c.headers["x-api-version"]).toBe("2024-01-01");
  });
});

describe("Cashfree payments: virtual account", () => {
  const vba = { virtual_bank_accounts: [{ vba_account_number: "94351020001772", vba_ifsc: "UTIB0CCH274", vba_status: "ACTIVE" }] };

  it("creates an account with an id derived from the key, using the collect keys", async () => {
    const f = stub(reply(200, vba));
    const pay = cashfreePayments(mock.payments, { ...creds, collect: { clientId: "pgid", clientSecret: "pgsecret" }, fetch: f });
    expect(await pay.issueVirtualAccount({ idempotencyKey: "va:inv-1" })).toEqual({ accountNumber: "94351020001772", ifsc: "UTIB0CCH274" });
    const c = call(f);
    expect(c.url).toBe("https://sandbox.cashfree.com/pg/vba");
    expect(c.init.method).toBe("POST");
    expect(c.headers).toMatchObject({ "x-client-id": "pgid", "x-client-secret": "pgsecret", "x-api-version": "2024-07-10T00:00:00.000Z" });
    const d = JSON.parse(c.body!).virtual_account_details;
    expect(d.virtual_account_id).toMatch(/^[A-Z0-9]+$/);
    expect(d).toHaveProperty("virtual_account_name");
    expect(d).toHaveProperty("virtual_account_email");
    expect(d).toHaveProperty("virtual_account_phone");
  });
  it("returns the existing account when the same key is sent again", async () => {
    const f = stub(reply(409, { type: "invalid_request_error", code: "order_already_exists", message: "exists" }), reply(200, vba));
    const pay = cashfreePayments(mock.payments, { ...creds, fetch: f });
    expect(await pay.issueVirtualAccount({ idempotencyKey: "va:inv-1" })).toEqual({ accountNumber: "94351020001772", ifsc: "UTIB0CCH274" });
    const id = JSON.parse(call(f, 0).body!).virtual_account_details.virtual_account_id;
    expect(call(f, 1).url).toBe(`https://sandbox.cashfree.com/pg/vba/${id}`);
    expect(call(f, 1).init.method).toBe("GET");
  });
  it("throws on a provider error, a timeout or an empty answer", async () => {
    const run = (a: Response | Error) => cashfreePayments(mock.payments, { ...creds, fetch: stub(a) }).issueVirtualAccount({ idempotencyKey: "k" });
    await expect(run(reply(502, { code: "bank_processing_failure", message: "bank" }))).rejects.toThrow(/502/);
    await expect(run(timeout)).rejects.toThrow(/timed out/);
    await expect(run(reply(200, { virtual_bank_accounts: [] }))).rejects.toThrow(/no account number/);
  });
});

describe("Cashfree credit webhook", () => {
  const raw = JSON.stringify({ data: {}, type: "PAYMENT_SUCCESS_WEBHOOK" });
  const sign = (ts: string, body: string, secret: string) => createHmac("sha256", secret).update(ts + body).digest("base64");

  it("verifies the signature over timestamp + raw body", () => {
    const ts = "1770000000000";
    const sig = sign(ts, raw, "secret");
    expect(verifyCashfreeWebhookSignature(raw, ts, sig, "secret")).toBe(true);
    expect(verifyCashfreeWebhookSignature(raw + " ", ts, sig, "secret")).toBe(false); // body changed
    expect(verifyCashfreeWebhookSignature(raw, "1770000000001", sig, "secret")).toBe(false); // timestamp changed
    expect(verifyCashfreeWebhookSignature(raw, ts, sig, "other")).toBe(false);
    expect(verifyCashfreeWebhookSignature(raw, ts, "bad", "secret")).toBe(false);
    expect(verifyCashfreeWebhookSignature(raw, null, sig, "secret")).toBe(false);
    expect(verifyCashfreeWebhookSignature(raw, ts, null, "secret")).toBe(false);
    expect(verifyCashfreeWebhookSignature(raw, ts, sig, "")).toBe(false);
  });

  const event = (over: Record<string, unknown> = {}) => ({
    type: "PAYMENT_SUCCESS_WEBHOOK",
    data: { payment: { payment_status: "SUCCESS", payment_amount: 1500.5, payment_time: "2026-02-05T15:19:36+05:30", bank_reference: "REF1",
      payment_method: { vba_transfer: { utr: "UTR123", vaccount_id: "USER09", vaccount_number: "98912574JSER10" } }, ...over } },
  });
  it("maps a virtual account credit to recordIncomingPayment's shape, in paise", () => {
    expect(parseCashfreeCredit(event())).toEqual({ accountNumber: "98912574JSER10", amount: 150_050n, utr: "UTR123", receivedAt: new Date("2026-02-05T15:19:36+05:30") });
    expect(parseCashfreeCredit(event({ payment_amount: 1500 }))?.amount).toBe(150_000n);
  });
  it("ignores other events and unsuccessful payments, and rejects a credit with no UTR", () => {
    expect(parseCashfreeCredit({ type: "PAYMENT_FAILED_WEBHOOK", data: {} })).toBeNull();
    expect(parseCashfreeCredit(event({ payment_status: "FAILED" }))).toBeNull();
    expect(parseCashfreeCredit(event({ payment_method: { upi: {} } }))).toBeNull();
    expect(() => parseCashfreeCredit(event({ bank_reference: undefined, payment_method: { vba_transfer: { vaccount_number: "A" } } }))).toThrow(/UTR/);
  });
});
