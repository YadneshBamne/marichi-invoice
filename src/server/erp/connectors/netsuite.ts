// Oracle NetSuite connector: pulls a seller's open customer invoices with SuiteQL over REST, signed in with OAuth 2.0 machine-to-machine.
// Written from Oracle's public NetSuite help:
//   M2M JWT (header kid = certificate id, claims iss/scope/aud/iat/exp, token POST):  https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_0312092247.html
//   Token response (access_token, expires_in 3600, token_type):                       https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_162755359851.html
//   SuiteQL over REST (POST .../services/rest/query/v1/suiteql, Prefer: transient):   https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_158394344595.html
//   Paging (limit up to 1000, offset a multiple of limit, hasMore/count/totalResults): https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_156414087576.html
//   Transaction columns and CustInvc status codes (A open, B paid in full), community-documented: https://timdietrich.me/blog/netsuite-suiteql-customer-invoices-by-date-range/
// Setup in NetSuite: an integration record with "Client credentials (M2M) flow" on, scope REST Web Services, and your public certificate
// under OAuth 2.0 Client Credentials (M2M) Setup (that gives the certificate id). The private key stays here. Signing: PS256 for an RSA
// key, ES256 for a P-256 EC key (NetSuite's list also has PS384/512 and ES384/512; those are not used here).
//
// How each invoice field is found:
//   buyer tax id  a custom field on the CUSTOMER record, cfg.taxIdField (its script id, e.g. "custentity_gstin"). Empty: null.
//   due date      transaction.duedate (NetSuite fills it from the terms). Empty: null.
//   amount        transaction.foreigntotal, in the invoice's own currency (currency.symbol is the ISO code).
//   PO reference  transaction.otherrefnum (the "PO #" field), or cfg.poField (a custom body field id such as "custbody_po").
//   open          type CustInvc, status open (A), and the whole total still unpaid (foreignamountunpaid = foreigntotal); part-paid are skipped.
import { createPrivateKey, constants, sign } from "node:crypto";
import { ConnectorError, requestJson, str, isoDay, toMinor, type ErpInvoiceRow } from "./types";

export type NetSuiteConfig = {
  accountId: string;          // e.g. "1234567" or sandbox "1234567_SB1"
  clientId: string;           // the integration record's Client ID (JWT "iss")
  certificateId: string;      // from the M2M setup record (JWT header "kid")
  privateKeyPem: string;
  taxIdField: string;         // script id of the customer's GSTIN field
  poField?: string;           // default "otherrefnum"
  scope?: string;             // default "rest_webservices"
  fetch?: typeof fetch;
  now?: () => Date;           // for tests
};

const PAGE = 1000;       // documented page size ceiling
const MAX_PAGES = 100;   // SuiteQL returns at most 100,000 rows per query (docs)
const KEYS = ["inv_total", "inv_unpaid"];
const FIELD = /^[a-z][a-z0-9_]*$/i; // column ids go into the SQL text: letters, digits, underscore only
const errorOf = (b: Record<string, unknown>) => {
  if (typeof b.error === "string") return `${b.error}${b.error_description ? `: ${str(b.error_description)}` : ""}`; // token endpoint
  const d = (b["o:errorDetails"] as { detail?: unknown }[] | undefined)?.[0]?.detail;                                // REST errors
  return d ? str(d) : undefined;
};
const b64u = (x: Buffer | string) => Buffer.from(x).toString("base64url");

export function netsuite(cfg: NetSuiteConfig) {
  const f = cfg.fetch ?? fetch;
  for (const [k, v] of [["taxIdField", cfg.taxIdField], ["poField", cfg.poField ?? "otherrefnum"]]) if (!FIELD.test(v)) throw new ConnectorError(`NetSuite ${k} "${v}" is not a valid field id`);
  // UNVERIFIED: host form. NetSuite shows <account id lower-case, "_" as "-">.suitetalk.api.netsuite.com (e.g. 1234567-sb1 for a sandbox).
  const host = `https://${cfg.accountId.toLowerCase().replace(/_/g, "-")}.suitetalk.api.netsuite.com`;
  const tokenUrl = `${host}/services/rest/auth/oauth2/v1/token`;

  /** The signed client assertion. aud is the token URL, as in Oracle's example. */
  function assertion(): string {
    let key;
    try { key = createPrivateKey(cfg.privateKeyPem); } catch { throw new ConnectorError("the NetSuite private key could not be read; paste the PEM of the key whose certificate you uploaded"); }
    const type = key.asymmetricKeyType;
    const alg = type === "ec" ? "ES256" : type === "rsa" || type === "rsa-pss" ? "PS256" : null;
    if (!alg) throw new ConnectorError("the NetSuite private key must be RSA (PS256) or EC P-256 (ES256)");
    const iat = Math.floor((cfg.now?.() ?? new Date()).getTime() / 1000);
    // UNVERIFIED: scope as a plain string (Oracle's example) rather than an array.
    const head = b64u(JSON.stringify({ typ: "JWT", alg, kid: cfg.certificateId }));
    const body = b64u(JSON.stringify({ iss: cfg.clientId, scope: cfg.scope ?? "rest_webservices", aud: tokenUrl, iat, exp: iat + 300 }));
    const data = Buffer.from(`${head}.${body}`);
    // JWT wants the raw r||s form for ECDSA (Oracle: useRawFormatForECDSA) and PSS with a salt as long as the hash.
    const sig = alg === "ES256"
      ? sign("sha256", data, { key, dsaEncoding: "ieee-p1363" })
      : sign("sha256", data, { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST });
    return `${head}.${body}.${b64u(sig)}`;
  }

  /** An access token (valid 60 minutes); a fresh one per sync is plenty. */
  async function accessToken(): Promise<string> {
    const b = await requestJson(f, "NetSuite", tokenUrl, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", client_assertion: assertion() }).toString(),
    }, KEYS, errorOf);
    if (typeof b.access_token !== "string") throw new ConnectorError("NetSuite did not return an access token; check the client id, certificate id and key");
    return b.access_token;
  }

  return {
    accessToken,

    /** Open invoices in full. `since` keeps documents last modified at or after that moment (UTC; NetSuite may compare in the account's time zone). */
    async listInvoices(p: { since?: Date } = {}): Promise<ErpInvoiceRow[]> {
      const token = await accessToken();
      const po = cfg.poField ?? "otherrefnum";
      // One line, no tabs or newlines (SuiteQL over REST rejects them).
      // UNVERIFIED: TO_CHAR/TO_DATE date formatting, currency.symbol as the ISO code, status 'A' vs 'CustInvc:A' (both are accepted below), and BUILTIN.DF fallback for the name.
      const sql = "SELECT t.id AS id, t.tranid AS tranid, TO_CHAR(t.trandate, 'YYYY-MM-DD') AS trandate, TO_CHAR(t.duedate, 'YYYY-MM-DD') AS duedate, "
        + `t.${po} AS po, t.foreigntotal AS inv_total, t.foreignamountunpaid AS inv_unpaid, cur.symbol AS currency, c.companyname AS customer, BUILTIN.DF(t.entity) AS customer_df, c.${cfg.taxIdField} AS taxid `
        + "FROM transaction t LEFT JOIN customer c ON c.id = t.entity LEFT JOIN currency cur ON cur.id = t.currency "
        + "WHERE t.type = 'CustInvc' AND t.status IN ('CustInvc:A', 'A')"
        + (p.since ? ` AND t.lastmodifieddate >= TO_DATE('${p.since.toISOString().slice(0, 19).replace("T", " ")}', 'YYYY-MM-DD HH24:MI:SS')` : "")
        + " ORDER BY t.id ASC"; // a unique sort order, so pages never repeat or skip a row
      const rows: ErpInvoiceRow[] = [];
      for (let n = 0; n < MAX_PAGES; n++) {
        const b = await requestJson(f, "NetSuite", `${host}/services/rest/query/v1/suiteql?limit=${PAGE}&offset=${n * PAGE}`, {
          method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json", prefer: "transient" },
          body: JSON.stringify({ q: sql }),
        }, KEYS, errorOf);
        if (!Array.isArray(b.items)) throw new ConnectorError("NetSuite sent an invoice list that could not be read");
        for (const raw of b.items as Record<string, unknown>[]) {
          const id = str(raw.id), number = str(raw.tranid), date = isoDay(raw.trandate), currency = str(raw.currency).toUpperCase();
          if (!id || !number || !date || !currency) throw new ConnectorError(`NetSuite sent invoice "${number || id || "?"}" with a missing number, date or currency`);
          const total = toMinor(str(raw.inv_total), currency);
          if (total === 0n || total !== toMinor(str(raw.inv_unpaid) || "0", currency)) continue; // nothing owed, or part-paid
          const gstin = str(raw.taxid);
          rows.push({
            externalId: id, invoiceNumber: number, buyerName: str(raw.customer) || str(raw.customer_df), buyerTaxId: gstin ? gstin.toUpperCase() : null,
            invoiceDate: date, dueDate: isoDay(raw.duedate), amountMinor: total, currency, poReference: str(raw.po) || null,
          });
        }
        if (b.hasMore === true || (b.hasMore === undefined && (b.items as unknown[]).length >= PAGE)) continue;
        return rows;
      }
      throw new ConnectorError("NetSuite has more invoices than one sync can read; narrow the date range");
    },
  };
}
