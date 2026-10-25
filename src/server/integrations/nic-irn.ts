// Real adapter for India's e-invoice portal (NIC IRP), written from NIC's public developer docs. Covers IrnPort: look up an e-invoice by IRN.
// Many businesses reach the IRP through a GSP instead, which usually has its own host and headers: baseUrl, authPath and irnPath are settable for that.
// Docs used (NIC e-invoice sandbox):
//   Index and endpoints:  https://einv-apisandbox.nic.in/index.html
//   Authentication v1.04: https://einv-apisandbox.nic.in/version1.04/authentication.html  (archive: .../version1.03/authentication.html)
//   Get IRN Details:      https://einv-apisandbox.nic.in/version1.03/get-eInvoicedetails.html
//   Invoice schema:       https://einv-apisandbox.nic.in/version1.03/generate-irn.html  (DocDtls.Dt is DD/MM/YYYY, SellerDtls.Gstin, BuyerDtls.Gstin, ValDtls.TotInvVal)
//   Sample code (RSA/AES): https://einv-apisandbox.nic.in/sample-code-in-java.html  and  .../sample-code-in-c-sharp-dot-net.html
//   Error codes:          https://einvoice1.gst.gov.in/others/geterrorcodes/VITAL  and  .../INV  (linked from https://einv-apisandbox.nic.in/api-error-codes-list.html)
//   Host prefixes:        eivital (auth) and eicore (invoice) are shown in GSP docs, e.g. https://docs.cleartax.in/cleartax-docs/e-invoicing-gsp-api/e-invoicing-gsp-api-reference/sample-api
// Flow: RSA-encrypt the credentials and a fresh AppKey with NIC's public key -> POST auth -> AuthToken + SEK (AES key, itself encrypted with the AppKey)
//       -> GET the IRN with the token -> decrypt `Data` with the SEK -> read the signed invoice.
import { constants, createCipheriv, createDecipheriv, publicEncrypt, randomBytes } from "node:crypto";
import type { IrnPort } from "./gateway";
import { rupeesToPaise } from "../../lib/money";

export type NicIrnConfig = {
  /** NIC's `<URL>` placeholder. Default is the developer sandbox; production is https://einvoice1.gst.gov.in, or your GSP's host. */
  baseUrl?: string;
  /** UNVERIFIED: NIC's pages only show `<URL>/v1.04/auth` and `<URL>/api/Invoice/irn/<irn>`; the eivital/eicore prefixes come from GSP docs. Confirm in the sandbox. */
  authPath?: string;
  irnPath?: string;
  clientId: string;
  clientSecret: string;
  /** The taxpayer GSTIN that logs in. UNVERIFIED: the portal may only return IRNs this GSTIN supplied (errors 2143 / 2226 throw here). */
  gstin: string;
  userName: string;
  password: string;
  /** NIC's public key (PEM, from the portal: einv_sandbox.pem for the sandbox). A PEM certificate also works. */
  publicKeyPem: string;
  fetch?: typeof fetch;
  now?: () => Date;
};

/** Encryption helpers, exported so tests can play NIC's side. */
export const nicEinvoiceCrypto = {
  newAppKey: () => randomBytes(32), // docs: a random 32-byte value, 44 characters in base64
  /** RSA (PKCS#1 v1.5, as in NIC's Java and C# samples) over base64(JSON), then base64: the `Data` of the auth request. */
  encryptAuth(publicKeyPem: string, c: { userName: string; password: string }, appKey: Buffer): string {
    const json = JSON.stringify({ UserName: c.userName, Password: c.password, AppKey: appKey.toString("base64"), ForceRefreshAccessToken: true });
    const plain = Buffer.from(Buffer.from(json).toString("base64"));
    return publicEncrypt({ key: publicKeyPem, padding: constants.RSA_PKCS1_PADDING }, plain).toString("base64");
  },
  /** AES-ECB with PKCS padding (docs: AES/ECB/PKCS7Padding; Java sample: PKCS5Padding, the same thing for 16-byte blocks). */
  aesEncrypt(key: Buffer, data: Buffer): string {
    const c = createCipheriv(`aes-${key.length * 8}-ecb`, key, null);
    return Buffer.concat([c.update(data), c.final()]).toString("base64");
  },
  aesDecrypt(key: Buffer, b64: string): Buffer {
    const d = createDecipheriv(`aes-${key.length * 8}-ecb`, key, null);
    return Buffer.concat([d.update(Buffer.from(b64, "base64")), d.final()]);
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
type Reply = { ok: boolean; status: number; json: Json; errors: { code: string; message: string }[] };

/** NIC sends errors as an array, an object, or (Get IRN) a base64 string holding a JSON array. */
function errorsOf(j: Json): Reply["errors"] {
  let e = j.ErrorDetails ?? j.error ?? j.Error;
  if (typeof e === "string") {
    try { e = JSON.parse(Buffer.from(e, "base64").toString("utf8")); } catch { try { e = JSON.parse(e); } catch { e = { ErrorMessage: e }; } }
  }
  return (Array.isArray(e) ? e : e ? [e] : []).map((x: Json) => ({ code: String(x?.ErrorCode ?? x?.errorCode ?? ""), message: String(x?.ErrorMessage ?? x?.errorMessage ?? "") }));
}

const problem = (what: string, r: Reply) =>
  new Error(`nic irp ${what} failed (${r.status}${r.errors[0]?.code ? ` ${r.errors[0].code}` : ""}): ${(r.errors[0]?.message ?? "").slice(0, 200)}`);

const SIX_HOURS = 6 * 3_600_000;
const REFRESH_BEFORE = 5 * 60_000; // NIC only hands out a new token in the last 10 minutes of the old one, so ask inside that window
const NOT_FOUND = "2148"; // "Requested IRN data is not available"
const BAD_TOKEN = "1005"; // "Invalid Token": expired, or wrong GSTIN / user / token in headers

export function nicIrn(cfg: NicIrnConfig): IrnPort {
  const f = cfg.fetch ?? fetch;
  const now = cfg.now ?? (() => new Date());
  const base = (cfg.baseUrl ?? "https://einv-apisandbox.nic.in").replace(/\/+$/, "");
  const gstin = cfg.gstin.trim().toUpperCase();
  // The docs' table writes client_id / client_secret, NIC's own samples write client-id / client-secret. Both are sent; servers drop underscore headers sometimes.
  const idHeaders = { client_id: cfg.clientId, "client-id": cfg.clientId, client_secret: cfg.clientSecret, "client-secret": cfg.clientSecret, Gstin: gstin };

  async function call(method: "GET" | "POST", path: string, headers: Record<string, string>, body?: string): Promise<Reply> {
    const res = await f(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", ...idHeaders, ...headers },
      body,
      signal: AbortSignal.timeout(60_000), // the gateway's own timeout is shorter; this only stops a hung socket
    });
    const text = await res.text();
    let json: Json = {};
    try { json = JSON.parse(text); } catch { /* non-JSON error page */ }
    json = json ?? {};
    const ok = res.ok && String(json.Status ?? json.status) === "1";
    return { ok, status: res.status, json, errors: errorsOf(json) };
  }

  type Session = { token: string; sek: Buffer; expiresAt: number };
  let session: Session | undefined;
  let signingIn: Promise<Session> | undefined;

  async function login(): Promise<Session> {
    const appKey = nicEinvoiceCrypto.newAppKey();
    const data = nicEinvoiceCrypto.encryptAuth(cfg.publicKeyPem, cfg, appKey);
    const r = await call("POST", cfg.authPath ?? "/eivital/v1.04/auth", {}, JSON.stringify({ Data: data }));
    if (!r.ok) throw problem("login", r);
    const { AuthToken, Sek, TokenExpiry } = r.json.Data ?? {};
    if (!AuthToken || !Sek) throw new Error("nic irp login response had no token or session key");
    const sek = nicEinvoiceCrypto.aesDecrypt(appKey, String(Sek));
    // UNVERIFIED: TokenExpiry (yyyy-MM-dd HH:mm:ss) has no timezone in the docs; Indian time is assumed. A wrong guess only costs an extra login or one retry on 1005.
    const t = Date.parse(`${String(TokenExpiry).replace(" ", "T")}+05:30`);
    const cap = now().getTime() + SIX_HOURS; // docs: 360 minutes in production, 60 in the sandbox
    return { token: String(AuthToken), sek, expiresAt: Number.isNaN(t) ? cap : Math.min(t, cap) };
  }

  async function getSession(fresh: boolean): Promise<Session> {
    if (!fresh && session && now().getTime() < session.expiresAt - REFRESH_BEFORE) return session;
    signingIn ??= login().then((s) => (session = s)).finally(() => { signingIn = undefined; }); // one login even if lookups overlap
    return signingIn;
  }

  return {
    async getIrn(irn) {
      let r: Reply, s: Session;
      for (let attempt = 0; ; attempt++) {
        s = await getSession(attempt > 0);
        r = await call("GET", `${cfg.irnPath ?? "/eicore/v1.03/Invoice/irn/"}${encodeURIComponent(irn)}`, { user_name: cfg.userName, AuthToken: s.token });
        const expired = r.status === 401 || r.errors.some((e) => e.code === BAD_TOKEN);
        if (expired && attempt === 0) { session = undefined; continue; } // token expired early: sign in once more
        break;
      }
      if (r.errors.some((e) => e.code === NOT_FOUND)) return null;
      // Everything else throws, including 2283 (IRN too old to fetch) and 2143 / 2226 (not your GSTIN): those say nothing about whether the IRN exists.
      if (!r.ok) throw problem("IRN lookup", r);
      if (typeof r.json.Data !== "string") throw new Error("nic irp IRN response had no data");

      let d: Json;
      try { d = JSON.parse(nicEinvoiceCrypto.aesDecrypt(s.sek, r.json.Data).toString("utf8")); } catch { throw new Error("nic irp IRN response could not be decrypted"); }
      if (d.Irn && String(d.Irn).toLowerCase() !== irn.toLowerCase()) throw new Error("nic irp returned a different IRN than asked for");
      return { ...readSignedInvoice(d.SignedInvoice), cancelled: d.Status !== "ACT" }; // CNL = cancelled, REJ = rejected: neither may be financed
    },
  };
}

/**
 * The signed invoice is a JWT; its payload holds the e-invoice JSON under `data`.
 * UNVERIFIED: NIC's pages do not document that layout (the sample tokens show it). The signature is not checked: the data came over TLS from the IRP itself.
 */
function readSignedInvoice(jwt: unknown) {
  const part = typeof jwt === "string" ? jwt.split(".")[1] : undefined;
  if (!part) throw new Error("nic irp IRN response had no signed invoice");
  let inv: Json, raw: string;
  try {
    const payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    raw = typeof payload.data === "string" ? payload.data : JSON.stringify(payload.data);
    inv = JSON.parse(raw);
  } catch { throw new Error("nic irp signed invoice could not be read"); }

  const sellerGstin = gst(inv.SellerDtls?.Gstin), buyerGstin = gst(inv.BuyerDtls?.Gstin); // buyer may be "URP" (unregistered)
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(inv.DocDtls?.Dt ?? ""));
  if (!sellerGstin || !buyerGstin || !m) throw new Error("nic irp signed invoice is missing seller, buyer or date");
  // The amount is a JSON number; JSON.parse would make it a float, so it is read from the raw text. ("TotInvValFc" does not match: the closing quote is part of the pattern.)
  const num = /"TotInvVal"\s*:\s*(\d+(?:\.\d+)?)/.exec(raw)?.[1] ?? (typeof inv.ValDtls?.TotInvVal === "number" ? String(inv.ValDtls.TotInvVal) : "");
  if (!num) throw new Error("nic irp signed invoice has no total value");
  return { amount: rupeesToPaise(num), buyerGstin, sellerGstin, date: `${m[3]}-${m[2]}-${m[1]}` };
}

const gst = (v: unknown) => (typeof v === "string" ? v.trim().toUpperCase() : "");
