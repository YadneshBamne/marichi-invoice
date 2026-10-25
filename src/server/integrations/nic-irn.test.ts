import { constants, generateKeyPairSync, privateDecrypt, randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { nicEinvoiceCrypto as crypto, nicIrn, type NicIrnConfig } from "./nic-irn";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }) as string;
const IRN = "a".repeat(64);
const SELLER = "29AABCT1332L1ZD", BUYER = "27AAACB2230M1ZT";

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");
const timeout = new DOMException("timed out", "TimeoutError");

/** Node 22 refuses PKCS#1 v1.5 private decryption, so decrypt raw and strip the padding (00 02 <random> 00 <message>) the way NIC's server would. */
function rsaDecrypt(data: Buffer): Buffer {
  const raw = privateDecrypt({ key: privateKey, padding: constants.RSA_NO_PADDING }, data);
  expect([raw[0], raw[1]]).toEqual([0, 2]);
  return raw.subarray(raw.indexOf(0, 2) + 1);
}

/** The e-invoice JSON as NIC holds it. The total is written as a raw number so float traps stay in the text. */
const invoiceJson = (o: { total?: string; dt?: string; seller?: string; buyer?: string } = {}) =>
  `{"Version":"1.1","DocDtls":{"Typ":"INV","No":"INV/1","Dt":"${o.dt ?? "05/03/2026"}"},"SellerDtls":{"Gstin":"${o.seller ?? SELLER}"},"BuyerDtls":{"Gstin":"${o.buyer ?? BUYER}"},` +
  `"ValDtls":{"AssVal":100000.00,"TotInvValFc":5.5,"TotInvVal":${o.total ?? "118000.50"}}}`;
const jwt = (data: string | object) => ["eyJhbGciOiJSUzI1NiJ9", Buffer.from(JSON.stringify({ data, iss: "NIC" })).toString("base64url"), "sig"].join(".");

const T0 = Date.parse("2026-03-10T10:00:00+05:30");
const ist = (ms: number) => new Date(ms + 5.5 * 3_600_000).toISOString().slice(0, 19).replace("T", " "); // NIC writes TokenExpiry in Indian time

/** Plays NIC's side: decrypts the login with the private key, hands out a token and SEK, answers IRN lookups encrypted with that SEK. */
function nic(o: { invoices?: Record<string, { status?: string; raw?: string | object; irn?: string }>; onGet?: (n: number) => Response | Error | undefined; tokenLife?: number } = {}) {
  const clock = { t: T0 };
  const tokens = new Map<string, { sek: Buffer; expires: number }>();
  const seen = { logins: 0, gets: 0, creds: [] as Record<string, unknown>[] };
  const calls: { url: string; method: string; headers: Record<string, string> }[] = [];
  const invoices = o.invoices ?? { [IRN]: {} };

  const f = vi.fn(async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    calls.push({ url, method: init.method!, headers });
    if (headers.client_id !== "cid" || headers.client_secret !== "csecret") return reply(200, { Status: "0", ErrorDetails: { ErrorCode: "1010", ErrorMessage: "Invalid Client-ID/Client-Secret" } });

    if (init.method === "POST") {
      seen.logins++;
      const inner = Buffer.from(rsaDecrypt(Buffer.from(JSON.parse(init.body as string).Data, "base64")).toString(), "base64").toString(); // base64 inside the RSA layer
      const c = JSON.parse(inner);
      seen.creds.push(c);
      if (c.Password !== "pw") return reply(200, { Status: "0", ErrorDetails: { ErrorCode: "1008", ErrorMessage: "Invalid login credentials" } });
      const appKey = Buffer.from(c.AppKey, "base64");
      expect(appKey).toHaveLength(32);
      const sek = randomBytes(32), token = `tok-${seen.logins}`;
      const expires = clock.t + (o.tokenLife ?? 6 * 3_600_000);
      tokens.set(token, { sek, expires });
      return reply(200, { Status: 1, ErrorDetails: null, Data: { ClientId: "cid", UserName: "user", AuthToken: token, Sek: crypto.aesEncrypt(appKey, sek), TokenExpiry: ist(expires) } });
    }

    seen.gets++;
    const forced = o.onGet?.(seen.gets);
    if (forced instanceof Error) throw forced;
    if (forced) return forced;
    const t = tokens.get(headers.AuthToken);
    if (!t || clock.t >= t.expires || headers.user_name !== "user" || headers.Gstin !== "29AABCT1332L1ZD") {
      return reply(200, { Status: "0", Data: null, ErrorDetails: b64([{ ErrorCode: "1005", ErrorMessage: "Invalid Token" }]) });
    }
    const irn = decodeURIComponent(url.split("/").pop()!);
    const inv = invoices[irn];
    if (!inv) return reply(200, { Status: "0", Data: null, ErrorDetails: b64([{ ErrorCode: "2148", ErrorMessage: "Requested IRN data is not available" }]) });
    const raw = inv.raw ?? invoiceJson();
    const data = { AckNo: 1, Irn: inv.irn ?? irn, SignedInvoice: jwt(raw), Status: inv.status ?? "ACT" };
    return reply(200, { Status: "1", ErrorDetails: null, Data: crypto.aesEncrypt(t.sek, Buffer.from(JSON.stringify(data))) });
  });
  return { fetch: f as unknown as typeof fetch, clock, seen, calls, f };
}

const cfg = (n: ReturnType<typeof nic>, over: Partial<NicIrnConfig> = {}): NicIrnConfig => ({
  clientId: "cid", clientSecret: "csecret", gstin: "29aabct1332l1zd", userName: "user", password: "pw", publicKeyPem,
  fetch: n.fetch, now: () => new Date(n.clock.t), ...over,
});

describe("NIC IRP: lookup flow", () => {
  it("logs in with the encrypted payload, then fetches and decrypts the invoice", async () => {
    const n = nic();
    expect(await nicIrn(cfg(n)).getIrn(IRN)).toEqual({ amount: 11_800_050n, buyerGstin: BUYER, sellerGstin: SELLER, date: "2026-03-05", cancelled: false });

    expect(n.calls[0]).toMatchObject({ method: "POST", url: "https://einv-apisandbox.nic.in/eivital/v1.04/auth" });
    expect(n.calls[0].headers).toMatchObject({ client_id: "cid", client_secret: "csecret", Gstin: "29AABCT1332L1ZD", "content-type": "application/json" });
    expect(n.seen.creds[0]).toMatchObject({ UserName: "user", Password: "pw", ForceRefreshAccessToken: true });
    expect(Buffer.from(n.seen.creds[0].AppKey as string, "base64")).toHaveLength(32); // 44 characters in base64

    expect(n.calls[1]).toMatchObject({ method: "GET", url: `https://einv-apisandbox.nic.in/eicore/v1.03/Invoice/irn/${IRN}` });
    expect(n.calls[1].headers).toMatchObject({ AuthToken: "tok-1", user_name: "user", Gstin: "29AABCT1332L1ZD", client_id: "cid", client_secret: "csecret" });
  });

  it("takes base URL and paths from the config (GSP or production)", async () => {
    const n = nic();
    await nicIrn(cfg(n, { baseUrl: "https://gsp.example.com/", authPath: "/einv/auth", irnPath: "/einv/irn/" })).getIrn(IRN);
    expect(n.calls.map((c) => c.url)).toEqual(["https://gsp.example.com/einv/auth", `https://gsp.example.com/einv/irn/${IRN}`]);
  });

  it("logs in once for two lookups, even when they overlap", async () => {
    const n = nic();
    const port = nicIrn(cfg(n));
    await Promise.all([port.getIrn(IRN), port.getIrn(IRN)]);
    await port.getIrn(IRN);
    expect(n.seen.logins).toBe(1);
    expect(n.seen.gets).toBe(3);
  });

  it("logs in again shortly before the token expires, not before", async () => {
    const n = nic();
    const port = nicIrn(cfg(n));
    await port.getIrn(IRN);
    n.clock.t += 5 * 3_600_000 + 50 * 60_000; // 5h50m of 6h
    await port.getIrn(IRN);
    expect(n.seen.logins).toBe(1);
    n.clock.t += 6 * 60_000; // inside the last 5 minutes
    await port.getIrn(IRN);
    expect(n.seen.logins).toBe(2);
    expect(n.calls.at(-1)!.headers.AuthToken).toBe("tok-2");
  });

  it("uses the shorter sandbox expiry the server reports", async () => {
    const n = nic({ tokenLife: 60 * 60_000 });
    const port = nicIrn(cfg(n));
    await port.getIrn(IRN);
    n.clock.t += 56 * 60_000;
    await port.getIrn(IRN);
    expect(n.seen.logins).toBe(2);
  });

  it("signs in once more when the server rejects the token early (1005 or 401), and no more than once", async () => {
    const early = nic({ onGet: (i) => (i === 1 ? reply(401, {}) : undefined) });
    expect((await nicIrn(cfg(early)).getIrn(IRN))?.amount).toBe(11_800_050n);
    expect(early.seen).toMatchObject({ logins: 2, gets: 2 });

    const dead = nic({ onGet: () => reply(200, { Status: "0", ErrorDetails: b64([{ ErrorCode: "1005", ErrorMessage: "Invalid Token" }]) }) });
    await expect(nicIrn(cfg(dead)).getIrn(IRN)).rejects.toThrow(/1005/);
    expect(dead.seen).toMatchObject({ logins: 2, gets: 2 });
  });
});

describe("NIC IRP: reading the invoice", () => {
  const get = (raw?: string, status?: string) => { const n = nic({ invoices: { [IRN]: { raw, status } } }); return nicIrn(cfg(n)).getIrn(IRN); };

  it("maps cancelled and rejected e-invoices to cancelled", async () => {
    expect(await get(undefined, "CNL")).toMatchObject({ cancelled: true });
    expect(await get(undefined, "REJ")).toMatchObject({ cancelled: true });
    expect(await get(undefined, "ACT")).toMatchObject({ cancelled: false });
  });
  it("turns the total into paise without floats", async () => {
    const cases: [string, bigint][] = [["118000.50", 11_800_050n], ["118000.5", 11_800_050n], ["1180", 118_000n], ["0.29", 29n], ["1.10", 110n], ["99999999999999.99", 9_999_999_999_999_999n]];
    for (const [total, paise] of cases) expect((await get(invoiceJson({ total })))?.amount).toBe(paise);
  });
  it("converts dd/mm/yyyy to yyyy-mm-dd", async () => {
    expect((await get(invoiceJson({ dt: "01/04/2026" })))?.date).toBe("2026-04-01");
    expect((await get(invoiceJson({ dt: "31/12/2025" })))?.date).toBe("2025-12-31");
  });
  it("upper-cases GST numbers and keeps URP for an unregistered buyer", async () => {
    expect(await get(invoiceJson({ seller: " 29aabct1332l1zd ", buyer: "27aaacb2230m1zt" }))).toMatchObject({ sellerGstin: SELLER, buyerGstin: BUYER });
    expect((await get(invoiceJson({ buyer: "URP" })))?.buyerGstin).toBe("URP");
  });
  it("accepts an invoice object inside the token as well as a JSON string", async () => {
    const n = nic({ invoices: { [IRN]: { raw: JSON.parse(invoiceJson()) } } });
    expect(await nicIrn(cfg(n)).getIrn(IRN)).toMatchObject({ amount: 11_800_050n, date: "2026-03-05" });
  });
});

describe("NIC IRP: not found and failures", () => {
  it("maps 'Requested IRN data is not available' (2148) to null", async () => {
    const n = nic({ invoices: {} });
    expect(await nicIrn(cfg(n)).getIrn(IRN)).toBeNull();
  });

  const run = (n: ReturnType<typeof nic>, over: Partial<NicIrnConfig> = {}) => nicIrn(cfg(n, over)).getIrn(IRN);
  const err = (code: string, message: string) => reply(200, { Status: "0", Data: null, ErrorDetails: b64([{ ErrorCode: code, ErrorMessage: message }]) });

  it("throws, never null, for an IRN that is too old, belongs to another GSTIN or has another error", async () => {
    await expect(run(nic({ onGet: () => err("2283", "IRN details cannot be provided as it is generated more than 3 days prior") }))).rejects.toThrow(/2283/);
    await expect(run(nic({ onGet: () => err("2143", "Invoice does not belongs to the user GSTIN") }))).rejects.toThrow(/2143/);
    await expect(run(nic({ onGet: () => err("2296", "Data not Found") }))).rejects.toThrow(/2296/);
    await expect(run(nic({ onGet: () => err("5001", "Application error") }))).rejects.toThrow(/5001/);
  });
  it("throws on HTTP errors, an error page, a timeout and a hung login", async () => {
    await expect(run(nic({ onGet: () => reply(500, { Status: "0" }) }))).rejects.toThrow(/500/);
    await expect(run(nic({ onGet: () => new Response("<html>Bad gateway</html>", { status: 502 }) }))).rejects.toThrow(/502/);
    await expect(run(nic({ onGet: () => new Response("not json", { status: 200 }) }))).rejects.toThrow(/IRN lookup failed/);
    await expect(run(nic({ onGet: () => timeout }))).rejects.toThrow(/timed out/);
    const down = vi.fn(async () => { throw timeout; });
    await expect(nicIrn({ ...cfg(nic()), fetch: down as unknown as typeof fetch }).getIrn(IRN)).rejects.toThrow(/timed out/);
  });
  it("throws on wrong credentials or client keys, with the portal's message", async () => {
    await expect(run(nic(), { password: "wrong" })).rejects.toThrow(/1008.*Invalid login credentials/);
    await expect(run(nic(), { clientSecret: "wrong" })).rejects.toThrow(/1010/);
  });
  it("throws when a login reply is incomplete, or a different IRN comes back, or the data cannot be read", async () => {
    const noToken = vi.fn(async () => reply(200, { Status: 1, Data: { ClientId: "cid" } }));
    await expect(nicIrn({ ...cfg(nic()), fetch: noToken as unknown as typeof fetch }).getIrn(IRN)).rejects.toThrow(/no token/);
    await expect(run(nic({ invoices: { [IRN]: { irn: "b".repeat(64) } } }))).rejects.toThrow(/different IRN/);
    await expect(run(nic({ invoices: { [IRN]: { raw: "{broken" } } }))).rejects.toThrow(/could not be read/);
    await expect(run(nic({ invoices: { [IRN]: { raw: invoiceJson({ dt: "2026-03-05" }) } } }))).rejects.toThrow(/missing seller, buyer or date/);
    await expect(run(nic({ invoices: { [IRN]: { raw: invoiceJson().replace('"TotInvVal":118000.50', '"Other":1') } } }))).rejects.toThrow(/total value/);
    await expect(run(nic({ invoices: { [IRN]: { raw: invoiceJson({ total: "1.234" }) } } }))).rejects.toThrow(/invalid amount/);
    // Data encrypted with some other key than this session's SEK
    const wrongKey = nic({ onGet: () => reply(200, { Status: "1", Data: crypto.aesEncrypt(randomBytes(32), Buffer.from("{}")) }) });
    await expect(run(wrongKey)).rejects.toThrow(/could not be decrypted/);
  });
});

describe("NIC encryption helpers", () => {
  it("round-trips AES-256-ECB and RSA-encrypts the login so only NIC's key can read it", () => {
    const key = randomBytes(32);
    expect(crypto.aesDecrypt(key, crypto.aesEncrypt(key, Buffer.from("hello")))).toEqual(Buffer.from("hello"));
    const appKey = crypto.newAppKey();
    const data = crypto.encryptAuth(publicKeyPem, { userName: "u", password: "p" }, appKey);
    const inner = JSON.parse(Buffer.from(rsaDecrypt(Buffer.from(data, "base64")).toString(), "base64").toString());
    expect(inner).toEqual({ UserName: "u", Password: "p", AppKey: appKey.toString("base64"), ForceRefreshAccessToken: true });
  });
});
