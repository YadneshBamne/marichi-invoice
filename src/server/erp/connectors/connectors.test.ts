import { describe, expect, it, vi } from "vitest";
import { zohoBooks } from "./zoho-books";
import { quickbooks } from "./quickbooks";
import { ConnectorError, quoteMoney, toMinor } from "./types";

const reply = (body: unknown, status = 200) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
/** A stub fetch that answers from a queue and records every call. */
const stub = (...answers: Response[]) => {
  const f = vi.fn(async () => answers.shift() ?? reply("unexpected call", 500));
  return { fetch: f as unknown as typeof fetch, call: (i: number) => f.mock.calls[i] as unknown as [string, RequestInit] };
};
const hdr = (init: RequestInit, k: string) => (init.headers as Record<string, string>)[k];
const zcfg = { clientId: "cid", clientSecret: "sec", redirectUri: "https://app.test/cb", dc: "in" as const };
const qcfg = { clientId: "cid", clientSecret: "sec", redirectUri: "https://app.test/cb", env: "sandbox" as const };

describe("toMinor", () => {
  it("converts without floats, for 2, 3 and 0 decimal currencies", () => {
    expect(toMinor("118000.10", "INR")).toBe(11800010n);
    expect(toMinor("0.07", "INR")).toBe(7n);
    expect(toMinor("19", "INR")).toBe(1900n);
    expect(toMinor("12.345", "KWD")).toBe(12345n);
    expect(toMinor("12.5", "BHD")).toBe(12500n);
    expect(toMinor("1500", "JPY")).toBe(1500n);
    expect(toMinor("1500.00", "JPY")).toBe(1500n); // trailing zeros are not lost precision
    expect(toMinor("90071992547409.93", "INR")).toBe(9007199254740993n); // beyond float range
  });
  it("rejects lost precision, negatives and junk", () => {
    expect(() => toMinor("10.005", "INR")).toThrow(/more decimals/);
    expect(() => toMinor("10.5", "JPY")).toThrow(/more decimals/);
    expect(() => toMinor("-5", "INR")).toThrow(ConnectorError);
    expect(() => toMinor("1e5", "INR")).toThrow(ConnectorError);
    expect(() => toMinor("", "INR")).toThrow(ConnectorError);
  });
});

describe("Zoho Books connector", () => {
  const zinv = (o: Record<string, unknown>) => ({ invoice_id: 1000000000000000001,  invoice_number: "INV-1", customer_name: "Acme Ltd", status: "sent", date: "2026-01-05", due_date: "2026-02-04", currency_code: "INR", total: 118000.1, balance: 118000.1, reference_number: "PO-9", ...o });
  // JSON.stringify keeps 118000.1 and the big id as written here; page_context is an object like the real API.
  const list = (invoices: unknown[], more: boolean) => JSON.stringify({ code: 0, message: "success", invoices, page_context: { page: 1, per_page: 200, has_more_page: more } }).replace(/1000000000000000000/g, "1000000000000000001");

  it("builds the data-centre authorize URL asking for a refresh token", () => {
    const u = new URL(zohoBooks(zcfg).authorizeUrl("st8"));
    expect(u.origin + u.pathname).toBe("https://accounts.zoho.in/oauth/v2/auth");
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ scope: "ZohoBooks.invoices.READ,ZohoBooks.settings.READ", client_id: "cid", response_type: "code", access_type: "offline", prompt: "consent", state: "st8", redirect_uri: "https://app.test/cb" });
    expect(zohoBooks({ ...zcfg, dc: "eu" }).authorizeUrl("s")).toContain("https://accounts.zoho.eu/");
  });
  it("exchanges a code and refreshes (keeping the refresh token)", async () => {
    const s = stub(reply({ access_token: "a1", refresh_token: "r1", api_domain: "https://www.zohoapis.in", expires_in: 3600 }), reply({ access_token: "a2", expires_in: 3600 }));
    const z = zohoBooks({ ...zcfg, fetch: s.fetch });
    expect(await z.exchangeCode("code1")).toEqual({ accessToken: "a1", refreshToken: "r1", expiresIn: 3600 });
    expect(s.call(0)[0]).toBe("https://accounts.zoho.in/oauth/v2/token");
    expect(new URLSearchParams(s.call(0)[1].body as string).get("grant_type")).toBe("authorization_code");
    expect(await z.refresh("r1")).toEqual({ accessToken: "a2", refreshToken: "r1", expiresIn: 3600 });
    const p = new URLSearchParams(s.call(1)[1].body as string);
    expect([p.get("grant_type"), p.get("refresh_token"), p.get("client_secret")]).toEqual(["refresh_token", "r1", "sec"]);
  });
  it("turns an OAuth error body (sent with HTTP 200) into a plain message", async () => {
    await expect(zohoBooks({ ...zcfg, fetch: stub(reply({ error: "invalid_code" })).fetch }).exchangeCode("old")).rejects.toThrow(/invalid_code/);
    await expect(zohoBooks({ ...zcfg, fetch: stub(reply({ access_token: "a" })).fetch }).exchangeCode("c")).rejects.toThrow(/refresh token/);
  });
  it("paginates, filters status, keeps exact money and ids, and fetches the GSTIN when the list lacks it", async () => {
    const s = stub(
      reply(list([zinv({}), zinv({ invoice_id: 2, invoice_number: "D", status: "draft" }), zinv({ invoice_id: 3, invoice_number: "V", status: "void" }), zinv({ invoice_id: 4, invoice_number: "P", status: "paid", balance: 0 })], true)),
      reply({ code: 0, invoice: { gst_no: "27aaapl1234c1zv" } }),
      reply(list([zinv({ invoice_id: 5, invoice_number: "INV-2", gst_no: "29AAAAA0000A1Z5", reference_number: "", due_date: "" }), zinv({ invoice_id: 6, invoice_number: "PART", balance: 5 })], false)),
    );
    const rows = await zohoBooks({ ...zcfg, fetch: s.fetch }).listInvoices({ accessToken: "tok", orgId: "777", since: new Date("2026-01-01T00:00:00Z") });
    expect(rows).toEqual([
      { externalId: "1000000000000000001", invoiceNumber: "INV-1", buyerName: "Acme Ltd", buyerTaxId: "27AAAPL1234C1ZV", invoiceDate: "2026-01-05", dueDate: "2026-02-04", amountMinor: 11800010n, currency: "INR", poReference: "PO-9" },
      { externalId: "5", invoiceNumber: "INV-2", buyerName: "Acme Ltd", buyerTaxId: "29AAAAA0000A1Z5", invoiceDate: "2026-01-05", dueDate: null, amountMinor: 11800010n, currency: "INR", poReference: null },
    ]);
    const u1 = new URL(s.call(0)[0]), u3 = new URL(s.call(2)[0]);
    expect(u1.origin + u1.pathname).toBe("https://www.zohoapis.in/books/v3/invoices");
    expect(Object.fromEntries(u1.searchParams)).toMatchObject({ organization_id: "777", status: "unpaid", page: "1", per_page: "200", last_modified_time: "2026-01-01T00:00:00+0000" });
    expect(u3.searchParams.get("page")).toBe("2");
    expect(new URL(s.call(1)[0]).pathname).toBe("/books/v3/invoices/1000000000000000001"); // id not rounded by a float
    expect(hdr(s.call(0)[1], "authorization")).toBe("Zoho-oauthtoken tok");
  });
  it("reads page_context given as a list, as in the docs example", async () => {
    const body = list([zinv({ gst_no: "29AAAAA0000A1Z5" })], false).replace(/"page_context":(\{[^}]*\})/, '"page_context":[$1]');
    expect(await zohoBooks({ ...zcfg, fetch: stub(reply(body)).fetch }).listInvoices({ accessToken: "t", orgId: "1" })).toHaveLength(1);
  });
  it("explains API errors, expired tokens, rate limits, junk and network failures", async () => {
    const run = (r: Response) => zohoBooks({ ...zcfg, fetch: stub(r).fetch }).listInvoices({ accessToken: "t", orgId: "1" });
    await expect(run(reply({ code: 57, message: "You are not authorized to perform this operation" }, 401))).rejects.toThrow(/not authorized.*expired/);
    await expect(run(reply({ code: 45, message: "rate limit" }, 429))).rejects.toThrow(/too many requests/);
    await expect(run(reply({ code: 5, message: "Invalid value passed for organization_id" }))).rejects.toThrow(/organization_id/);
    await expect(run(reply("<html>gateway</html>", 502))).rejects.toThrow(/HTTP 502/);
    await expect(run(reply("<html>ok?</html>"))).rejects.toThrow(/could not be read/);
    await expect(run(reply({ code: 0 }))).rejects.toThrow(/invoice list/);
    await expect(run(reply(list([zinv({ date: "05/01/2026", gst_no: "x" })], false)))).rejects.toThrow(/missing/);
    const down = vi.fn(async () => { throw new Error("ECONNRESET"); });
    await expect(zohoBooks({ ...zcfg, fetch: down as unknown as typeof fetch }).listInvoices({ accessToken: "t", orgId: "1" })).rejects.toThrow(/could not reach Zoho Books/);
  });
});

describe("QuickBooks connector", () => {
  const qinv = (o: Record<string, unknown>) => ({
    Id: "10", DocNumber: "1001", TxnDate: "2026-01-05", DueDate: "2026-02-04", CurrencyRef: { value: "INR" }, CustomerRef: { value: "5", name: "Acme Ltd" }, TotalAmt: 118000.1, Balance: 118000.1,
    CustomField: [{ DefinitionId: "1", Name: "Buyer GSTIN", Type: "StringType", StringValue: "27aaapl1234c1zv" }, { DefinitionId: "2", Name: "P.O. Number", Type: "StringType", StringValue: "PO-9" }], ...o,
  });
  const body = (invoices: unknown[]) => JSON.stringify({ QueryResponse: { Invoice: invoices, startPosition: 1 } });
  const ask = (r: Response, extra = {}) => quickbooks({ ...qcfg, ...extra, fetch: stub(r).fetch }).listInvoices({ accessToken: "t", realmId: "1" });

  it("builds the authorize URL and uses the sandbox or production host", async () => {
    const u = new URL(quickbooks(qcfg).authorizeUrl("st8"));
    expect(u.origin + u.pathname).toBe("https://appcenter.intuit.com/connect/oauth2");
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ client_id: "cid", scope: "com.intuit.quickbooks.accounting", response_type: "code", state: "st8" });
    for (const [env, host] of [["sandbox", "https://sandbox-quickbooks.api.intuit.com"], ["production", "https://quickbooks.api.intuit.com"]] as const) {
      const s = stub(reply({ QueryResponse: {} }));
      expect(await quickbooks({ ...qcfg, env, fetch: s.fetch }).listInvoices({ accessToken: "t", realmId: "123" })).toEqual([]);
      expect(s.call(0)[0].startsWith(`${host}/v3/company/123/query?`)).toBe(true);
    }
  });
  it("exchanges a code and refreshes with Basic auth, returning the new refresh token", async () => {
    const s = stub(reply({ access_token: "a1", refresh_token: "r1", expires_in: 3600, x_refresh_token_expires_in: 8726400 }), reply({ access_token: "a2", refresh_token: "r2", expires_in: 3600 }));
    const q = quickbooks({ ...qcfg, fetch: s.fetch });
    expect(await q.exchangeCode("c")).toEqual({ accessToken: "a1", refreshToken: "r1", expiresIn: 3600 });
    expect(s.call(0)[0]).toBe("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer");
    expect(hdr(s.call(0)[1], "authorization")).toBe(`Basic ${Buffer.from("cid:sec").toString("base64")}`);
    expect(Object.fromEntries(new URLSearchParams(s.call(0)[1].body as string))).toEqual({ grant_type: "authorization_code", code: "c", redirect_uri: "https://app.test/cb" });
    expect(await q.refresh("r1")).toEqual({ accessToken: "a2", refreshToken: "r2", expiresIn: 3600 });
    expect(Object.fromEntries(new URLSearchParams(s.call(1)[1].body as string))).toEqual({ grant_type: "refresh_token", refresh_token: "r1" });
  });
  it("explains a rejected or incomplete token reply", async () => {
    await expect(quickbooks({ ...qcfg, fetch: stub(reply({ error: "invalid_grant", error_description: "Incorrect or invalid refresh token" }, 400)).fetch }).refresh("x")).rejects.toThrow(/invalid_grant: Incorrect or invalid refresh token/);
    await expect(quickbooks({ ...qcfg, fetch: stub(reply({ access_token: "a" })).fetch }).refresh("x")).rejects.toThrow(/did not return tokens/);
  });
  it("maps invoices, skipping void, paid and part-paid, and reads GSTIN and PO from custom fields", async () => {
    const s = stub(reply(body([
      qinv({}), qinv({ Id: "11", DocNumber: "V", TotalAmt: 0, Balance: 0 }), qinv({ Id: "12", DocNumber: "P", Balance: 0 }),
      qinv({ Id: "13", DocNumber: "H", Balance: 5.5 }), qinv({ Id: "14", DocNumber: "1002", CustomField: [], DueDate: undefined }),
    ])));
    const rows = await quickbooks({ ...qcfg, fetch: s.fetch }).listInvoices({ accessToken: "tok", realmId: "123", since: new Date("2026-01-01T00:00:00Z") });
    expect(rows).toEqual([
      { externalId: "10", invoiceNumber: "1001", buyerName: "Acme Ltd", buyerTaxId: "27AAAPL1234C1ZV", invoiceDate: "2026-01-05", dueDate: "2026-02-04", amountMinor: 11800010n, currency: "INR", poReference: "PO-9" },
      { externalId: "14", invoiceNumber: "1002", buyerName: "Acme Ltd", buyerTaxId: null, invoiceDate: "2026-01-05", dueDate: null, amountMinor: 11800010n, currency: "INR", poReference: null },
    ]);
    expect(new URL(s.call(0)[0]).searchParams.get("query")).toBe("SELECT * FROM Invoice WHERE MetaData.LastUpdatedTime > '2026-01-01T00:00:00+00:00' STARTPOSITION 1 MAXRESULTS 1000");
    expect(hdr(s.call(0)[1], "authorization")).toBe("Bearer tok");
  });
  it("uses the configured custom field names", async () => {
    const row = qinv({ CustomField: [{ Name: "GST No", StringValue: "29AAAAA0000A1Z5" }, { Name: "PO", StringValue: "X1" }] });
    const [r] = await ask(reply(body([row])), { taxIdField: "gst no", poField: "po" });
    expect([r.buyerTaxId, r.poReference]).toEqual(["29AAAAA0000A1Z5", "X1"]);
  });
  it("pages by STARTPOSITION until a short page, with exact money in a 3-decimal currency", async () => {
    const full = Array.from({ length: 1000 }, (_, i) => qinv({ Id: String(i), DocNumber: `N${i}`, TotalAmt: 0, Balance: 0 })); // all skipped: only paging is tested
    const kwd = qinv({ Id: "k", DocNumber: "K1", CurrencyRef: { value: "KWD" }, TotalAmt: 12.345, Balance: 12.345 });
    const s = stub(reply(body(full)), reply(body([kwd])));
    const rows = await quickbooks({ ...qcfg, fetch: s.fetch }).listInvoices({ accessToken: "t", realmId: "1" });
    expect(new URL(s.call(1)[0]).searchParams.get("query")).toBe("SELECT * FROM Invoice STARTPOSITION 1001 MAXRESULTS 1000");
    expect(rows.map((r) => [r.invoiceNumber, r.amountMinor, r.currency])).toEqual([["K1", 12345n, "KWD"]]);
  });
  it("falls back to the default currency, and errors plainly without one", async () => {
    const noCur = qinv({ CurrencyRef: undefined });
    expect((await ask(reply(body([noCur])), { defaultCurrency: "inr" }))[0].currency).toBe("INR");
    await expect(ask(reply(body([noCur])))).rejects.toThrow(/missing/);
  });
  it("explains Fault errors, expired tokens, junk and network failures", async () => {
    await expect(ask(reply({ Fault: { Error: [{ Message: "message=AuthenticationFailed", Detail: "Token expired" }], type: "AUTHENTICATION" } }, 401))).rejects.toThrow(/Token expired.*expired/);
    await expect(ask(reply({ Fault: { Error: [{ Message: "Invalid query", Detail: "bad STARTPOSITION" }] } }, 400))).rejects.toThrow(/Invalid query: bad STARTPOSITION/);
    await expect(ask(reply("not json", 500))).rejects.toThrow(/HTTP 500/);
    await expect(ask(reply({ QueryResponse: { Invoice: "oops" } }))).rejects.toThrow(/could not be read/);
    await expect(ask(reply(body([qinv({ TxnDate: "yesterday" })])))).rejects.toThrow(/missing/);
    const down = vi.fn(async () => { throw new Error("offline"); });
    await expect(quickbooks({ ...qcfg, fetch: down as unknown as typeof fetch }).listInvoices({ accessToken: "t", realmId: "1" })).rejects.toThrow(/could not reach QuickBooks/);
  });
});

describe("quoteMoney", () => {
  it("keeps digits a float would lose, only for the named keys", () => {
    const out = quoteMoney('{"total": 90071992547409.93, "item_total": 5.5, "balance":0.1,"id":12}', ["total", "balance"]);
    expect(out).toBe('{"total": "90071992547409.93", "item_total": 5.5, "balance":"0.1","id":12}');
  });
});
