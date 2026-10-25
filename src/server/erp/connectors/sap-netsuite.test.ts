import { generateKeyPairSync, constants, verify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { sapBilling } from "./sap";
import { netsuite } from "./netsuite";
import { ConnectorError } from "./types";

const reply = (body: unknown, status = 200) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
/** A stub fetch that answers from a queue and records every call. */
const stub = (...answers: Response[]) => {
  const f = vi.fn(async () => answers.shift() ?? reply("unexpected call", 500));
  return { fetch: f as unknown as typeof fetch, calls: f.mock.calls as unknown as [string, RequestInit][], call: (i: number) => f.mock.calls[i] as unknown as [string, RequestInit] };
};
const hdr = (init: RequestInit, k: string) => (init.headers as Record<string, string>)[k];

// ---------- SAP ----------
const day = (iso: string) => `/Date(${Date.parse(iso)})/`;
const doc = (o: Record<string, unknown>) => ({
  BillingDocument: "90000001", BillingDocumentType: "F2", BillingDocumentDate: day("2026-01-05"), BillingDocumentIsCancelled: false, CancelledBillingDocument: "",
  TotalNetAmount: "100000.00", TaxAmount: "18000.10", TransactionCurrency: "INR", CustomerPaymentTerms: "NT30", AdditionalValueDays: "00", FixedValueDate: null,
  SoldToParty: "1000", PayerParty: "", PurchaseOrderByCustomer: "PO-9", InvoiceClearingStatus: "A", ...o,
});
const page = (results: unknown[], next?: string) => ({ d: { results, ...(next ? { __next: next } : {}) } });
const bp = { d: { results: [{ BusinessPartner: "1000", BusinessPartnerFullName: "Acme Ltd" }] } };
const tax = (n: string) => ({ d: { results: [{ BusinessPartner: "1000", BPTaxType: "IN3", BPTaxNumber: n }] } });
const sandbox = { baseUrl: "https://sandbox.api.sap.com/s4hanacloud/", auth: { kind: "apikey" as const, apiKey: "KEY123" }, creditDays: { NT30: 30 } };

describe("SAP billing connector", () => {
  it("works on the sandbox with an API key, follows __next, drops cancelled/paid/other types, adds net+tax exactly", async () => {
    const s = stub(
      reply(page([
        doc({}),
        doc({ BillingDocument: "2", BillingDocumentIsCancelled: true }),
        doc({ BillingDocument: "3", InvoiceClearingStatus: "C" }),
        doc({ BillingDocument: "4", BillingDocumentType: "G2" }),
        doc({ BillingDocument: "5", CancelledBillingDocument: "90000001" }),
      ], "A_BillingDocument?$skiptoken=200")),
      reply(page([
        doc({ BillingDocument: "90000002", FixedValueDate: day("2026-03-01"), CustomerPaymentTerms: "ZZZZ", PurchaseOrderByCustomer: "" }),
        doc({ BillingDocument: "6", InvoiceClearingStatus: "B" }),
      ])),
      reply(bp), reply(tax("27aaapl1234c1zv")),
    );
    const rows = await sapBilling({ ...sandbox, fetch: s.fetch }).listInvoices({ since: new Date("2026-01-01T10:00:00Z") });
    expect(rows).toEqual([
      { externalId: "90000001", invoiceNumber: "90000001", buyerName: "Acme Ltd", buyerTaxId: "27AAAPL1234C1ZV", invoiceDate: "2026-01-05", dueDate: "2026-02-04", amountMinor: 11800010n, currency: "INR", poReference: "PO-9" },
      { externalId: "90000002", invoiceNumber: "90000002", buyerName: "Acme Ltd", buyerTaxId: "27AAAPL1234C1ZV", invoiceDate: "2026-01-05", dueDate: "2026-03-01", amountMinor: 11800010n, currency: "INR", poReference: null },
    ]);
    expect(s.calls).toHaveLength(4); // 2 invoice pages, then one name and one GSTIN lookup (cached for the second invoice)
    const u = new URL(s.call(0)[0]);
    expect(u.origin + u.pathname).toBe("https://sandbox.api.sap.com/s4hanacloud/sap/opu/odata/sap/API_BILLING_DOCUMENT_SRV/A_BillingDocument");
    expect(hdr(s.call(0)[1], "APIKey")).toBe("KEY123");
    const filter = u.searchParams.get("$filter")!;
    expect(filter).toContain("BillingDocumentIsCancelled eq false");
    expect(filter).toContain("BillingDocumentType eq 'F2'");
    expect(filter).toContain("LastChangeDate ge datetime'2026-01-01T00:00:00'");
    expect(u.searchParams.get("$format")).toBe("json");
    expect(s.call(1)[0]).toBe("https://sandbox.api.sap.com/s4hanacloud/sap/opu/odata/sap/API_BILLING_DOCUMENT_SRV/A_BillingDocument?$skiptoken=200");
    const bpUrl = new URL(s.call(2)[0]), taxUrl = new URL(s.call(3)[0]);
    expect(bpUrl.pathname).toBe("/s4hanacloud/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BusinessPartner");
    expect(bpUrl.searchParams.get("$filter")).toBe("Customer eq '1000'");
    expect(taxUrl.pathname).toMatch(/A_BusinessPartnerTaxNumber$/);
    expect(taxUrl.searchParams.get("$filter")).toBe("BusinessPartner eq '1000' and BPTaxType eq 'IN3'");
  });

  it("pages with $top/$skip when the server sends no __next, and reads custom invoice types and tax category", async () => {
    const full = Array.from({ length: 200 }, (_, i) => doc({ BillingDocument: `A${i}`, BillingDocumentType: "ZF2" }));
    const s = stub(reply(page(full)), reply(page([doc({ BillingDocument: "last", BillingDocumentType: "ZF2" })])), reply(bp), reply(tax("29AAAAA0000A1Z5")));
    const rows = await sapBilling({ ...sandbox, invoiceTypes: ["F2", "ZF2"], taxCategory: "IN9", fetch: s.fetch }).listInvoices();
    expect(rows).toHaveLength(201);
    expect(new URL(s.call(1)[0]).searchParams.get("$skip")).toBe("200");
    expect(new URL(s.call(0)[0]).searchParams.get("$filter")).toContain("(BillingDocumentType eq 'F2' or BillingDocumentType eq 'ZF2')");
    expect(new URL(s.call(3)[0]).searchParams.get("$filter")).toContain("BPTaxType eq 'IN9'");
  });

  it("gives nulls for a missing GSTIN, unknown partner and unknown payment terms", async () => {
    const s = stub(
      reply(page([doc({ CustomerPaymentTerms: "ZZZZ" }), doc({ BillingDocument: "7", SoldToParty: "2000", PayerParty: "3000", CustomerPaymentTerms: "ZZZZ" })])),
      reply(bp), reply({ d: { results: [] } }), // partner 1000 has no GSTIN
      reply({ d: { results: [] } }),            // customer 3000 is not a partner
    );
    const rows = await sapBilling({ baseUrl: "https://x.test", auth: { kind: "apikey", apiKey: "k" }, fetch: s.fetch }).listInvoices();
    expect(rows.map((r) => [r.buyerName, r.buyerTaxId, r.dueDate])).toEqual([["Acme Ltd", null, null], ["3000", null, null]]);
    expect(new URL(s.call(3)[0]).searchParams.get("$filter")).toBe("Customer eq '3000'"); // the payer, not the sold-to party
  });

  it("uses default credit days and the additional value days", async () => {
    const s = stub(reply(page([doc({ CustomerPaymentTerms: "ZZZZ", AdditionalValueDays: "05" })])), reply(bp), reply(tax("29AAAAA0000A1Z5")));
    const rows = await sapBilling({ baseUrl: "https://x.test", auth: { kind: "apikey", apiKey: "k" }, defaultCreditDays: 45, fetch: s.fetch }).listInvoices();
    expect(rows[0].dueDate).toBe("2026-02-24"); // 5 Jan + 5 + 45 days
  });

  it("signs in with basic auth, and with OAuth client credentials", async () => {
    const b = stub(reply(page([])));
    await sapBilling({ baseUrl: "https://x.test", auth: { kind: "basic", user: "u", password: "p" }, fetch: b.fetch }).listInvoices();
    expect(hdr(b.call(0)[1], "authorization")).toBe(`Basic ${Buffer.from("u:p").toString("base64")}`);

    const o = stub(reply({ access_token: "tok1", expires_in: 3600 }), reply(page([])));
    await sapBilling({ baseUrl: "https://x.test", auth: { kind: "oauth", tokenUrl: "https://uaa.test/oauth/token", clientId: "cid", clientSecret: "sec" }, fetch: o.fetch }).listInvoices();
    expect(o.call(0)[0]).toBe("https://uaa.test/oauth/token");
    expect(hdr(o.call(0)[1], "authorization")).toBe(`Basic ${Buffer.from("cid:sec").toString("base64")}`);
    expect(o.call(0)[1].body).toBe("grant_type=client_credentials");
    expect(hdr(o.call(1)[1], "authorization")).toBe("Bearer tok1");
  });

  it("maps errors to plain messages", async () => {
    const run = (r: Response) => sapBilling({ baseUrl: "https://x.test", auth: { kind: "apikey", apiKey: "k" }, fetch: stub(r).fetch }).listInvoices();
    await expect(run(reply({ error: { code: "/IWBEP/CM_MGW_RT/021", message: { lang: "en", value: "Resource not found" } } }, 404))).rejects.toThrow(/Resource not found/);
    await expect(run(reply("denied", 401))).rejects.toThrow(/HTTP 401.*expired/);
    await expect(run(reply({ d: {} }))).rejects.toThrow(/could not be read/);
    await expect(run(reply(page([doc({ BillingDocumentDate: null })])))).rejects.toThrow(/missing number, date or currency/);
    await expect(sapBilling({ baseUrl: "https://x.test", auth: { kind: "oauth", tokenUrl: "https://uaa.test/t", clientId: "c", clientSecret: "s" }, fetch: stub(reply({ error: "invalid_client", error_description: "bad secret" }, 401)).fetch }).listInvoices()).rejects.toThrow(/invalid_client: bad secret/);
    const e = await run(reply("x", 500)).catch((x) => x);
    expect(e).toBeInstanceOf(ConnectorError);
  });
});

// ---------- NetSuite ----------
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pem = (k: { export: (o: { type: "pkcs8"; format: "pem" }) => string | Buffer }) => k.export({ type: "pkcs8", format: "pem" }) as string;
const NOW = new Date("2026-02-01T00:00:00Z");
const ncfg = { accountId: "1234567_SB1", clientId: "cid", certificateId: "cert-1", privateKeyPem: pem(rsa.privateKey), taxIdField: "custentity_gstin", now: () => NOW };
const TOKEN_URL = "https://1234567-sb1.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token";
const tokenReply = () => reply({ access_token: "nsTok", expires_in: 3600, token_type: "Bearer" });
const inv = (o: Record<string, unknown>) => ({ links: [], id: "501", tranid: "INV-1", trandate: "2026-01-05", duedate: "2026-02-04", po: "PO-9", inv_total: 118000.1, inv_unpaid: 118000.1, currency: "INR", customer: "Acme Ltd", customer_df: "C12 Acme Ltd", taxid: "27aaapl1234c1zv", ...o });
const items = (rows: unknown[], hasMore: boolean) => reply({ links: [], count: rows.length, hasMore, offset: 0, totalResults: rows.length, items: rows });

describe("NetSuite connector", () => {
  const decode = (jwt: string) => { const [h, p, s] = jwt.split("."); return { h: JSON.parse(Buffer.from(h, "base64url").toString()), p: JSON.parse(Buffer.from(p, "base64url").toString()), data: Buffer.from(`${h}.${p}`), sig: Buffer.from(s, "base64url") }; };
  const assertionOf = (init: RequestInit) => new URLSearchParams(init.body as string);

  it("asks for a token with an RSA PS256 JWT that verifies against the public key", async () => {
    const s = stub(tokenReply());
    expect(await netsuite({ ...ncfg, fetch: s.fetch }).accessToken()).toBe("nsTok");
    expect(s.call(0)[0]).toBe(TOKEN_URL);
    const form = assertionOf(s.call(0)[1]);
    expect(form.get("grant_type")).toBe("client_credentials");
    expect(form.get("client_assertion_type")).toBe("urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
    const j = decode(form.get("client_assertion")!);
    expect(j.h).toEqual({ typ: "JWT", alg: "PS256", kid: "cert-1" });
    expect(j.p).toEqual({ iss: "cid", scope: "rest_webservices", aud: TOKEN_URL, iat: NOW.getTime() / 1000, exp: NOW.getTime() / 1000 + 300 });
    expect(verify("sha256", j.data, { key: rsa.publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST }, j.sig)).toBe(true);
    expect(verify("sha256", Buffer.concat([j.data, Buffer.from("x")]), { key: rsa.publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST }, j.sig)).toBe(false);
  });

  it("uses ES256 (raw r||s signature) for an EC key", async () => {
    const s = stub(tokenReply());
    await netsuite({ ...ncfg, privateKeyPem: pem(ec.privateKey), scope: "restlets", fetch: s.fetch }).accessToken();
    const j = decode(assertionOf(s.call(0)[1]).get("client_assertion")!);
    expect(j.h.alg).toBe("ES256");
    expect(j.p.scope).toBe("restlets");
    expect(j.sig).toHaveLength(64);
    expect(verify("sha256", j.data, { key: ec.publicKey, dsaEncoding: "ieee-p1363" }, j.sig)).toBe(true);
  });

  it("pages with limit/offset, filters paid and part-paid, keeps exact money, and sends one-line SuiteQL", async () => {
    const s = stub(
      tokenReply(),
      items([inv({}), inv({ id: "502", tranid: "PAID", inv_unpaid: 0 }), inv({ id: "503", tranid: "PART", inv_unpaid: 5 })], true),
      items([inv({ id: "504", tranid: "INV-2", taxid: null, duedate: null, po: null, customer: null })], false),
    );
    const rows = await netsuite({ ...ncfg, poField: "custbody_po", fetch: s.fetch }).listInvoices({ since: new Date("2026-01-01T08:30:00Z") });
    expect(rows).toEqual([
      { externalId: "501", invoiceNumber: "INV-1", buyerName: "Acme Ltd", buyerTaxId: "27AAAPL1234C1ZV", invoiceDate: "2026-01-05", dueDate: "2026-02-04", amountMinor: 11800010n, currency: "INR", poReference: "PO-9" },
      { externalId: "504", invoiceNumber: "INV-2", buyerName: "C12 Acme Ltd", buyerTaxId: null, invoiceDate: "2026-01-05", dueDate: null, amountMinor: 11800010n, currency: "INR", poReference: null },
    ]);
    expect(s.calls).toHaveLength(3);
    const [u1, i1] = s.call(1), [u2] = s.call(2);
    expect(u1).toBe("https://1234567-sb1.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql?limit=1000&offset=0");
    expect(u2).toContain("limit=1000&offset=1000");
    expect(i1.method).toBe("POST");
    expect(hdr(i1, "prefer")).toBe("transient");
    expect(hdr(i1, "authorization")).toBe("Bearer nsTok");
    const q = JSON.parse(i1.body as string).q as string;
    expect(q).not.toMatch(/[\n\t]/);
    expect(q).toContain("t.type = 'CustInvc'");
    expect(q).toContain("c.custentity_gstin AS taxid");
    expect(q).toContain("t.custbody_po AS po");
    expect(q).toContain("TO_DATE('2026-01-01 08:30:00'");
    expect(q).toContain("ORDER BY t.id ASC");
    expect(JSON.parse(s.call(2)[1].body as string).q).toBe(q);
  });

  it("stops at the last page when hasMore is false, and an empty result is fine", async () => {
    const s = stub(tokenReply(), items([], false));
    expect(await netsuite({ ...ncfg, fetch: s.fetch }).listInvoices()).toEqual([]);
    expect(s.calls).toHaveLength(2);
    expect(JSON.parse(s.call(1)[1].body as string).q).not.toContain("lastmodifieddate");
  });

  it("maps errors to plain messages", async () => {
    const list = (...a: Response[]) => netsuite({ ...ncfg, fetch: stub(...a).fetch }).listInvoices();
    await expect(list(reply({ error: "invalid_grant", error_description: "bad assertion" }, 400))).rejects.toThrow(/invalid_grant: bad assertion/);
    await expect(list(reply({ foo: 1 }))).rejects.toThrow(/did not return an access token/);
    await expect(list(tokenReply(), reply({ title: "Unauthorized", status: 401, "o:errorDetails": [{ detail: "Invalid login attempt." }] }, 401))).rejects.toThrow(/Invalid login attempt\..*expired/);
    await expect(list(tokenReply(), reply("", 429))).rejects.toThrow(/too many requests/);
    await expect(list(tokenReply(), reply({ count: 0 }))).rejects.toThrow(/could not be read/);
    await expect(list(tokenReply(), items([inv({ currency: null })], false))).rejects.toThrow(/missing number, date or currency/);
    await expect(list(tokenReply(), items([inv({ trandate: null })], false))).rejects.toThrow(/missing number, date or currency/);
    await expect(netsuite({ ...ncfg, privateKeyPem: "not a key", fetch: stub().fetch }).accessToken()).rejects.toThrow(/private key could not be read/);
    await expect(netsuite({ ...ncfg, privateKeyPem: pem(generateKeyPairSync("ed25519").privateKey), fetch: stub().fetch }).accessToken()).rejects.toThrow(/RSA .* or EC/);
  });

  it("refuses a field id that could change the SQL", () => {
    expect(() => netsuite({ ...ncfg, taxIdField: "custentity_x FROM customer --" })).toThrow(ConnectorError);
    expect(() => netsuite({ ...ncfg, poField: "otherrefnum' OR '1'='1" })).toThrow(ConnectorError);
  });
});
