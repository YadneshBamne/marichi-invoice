// SAP S/4HANA (Cloud or the SAP Business Accelerator Hub sandbox) connector: pulls a seller's open customer invoices over OData v2.
// Written from SAP's public API definitions (api.sap.com needs a login for the full spec pages; the field names below were read from the
// SAP-generated Cloud SDK models of the same EDMX, @sap/cloud-sdk-vdm-billing-document-service and ...-business-partner-service 2.1.0):
//   Billing documents:  https://api.sap.com/api/API_BILLING_DOCUMENT_SRV/overview    (A_BillingDocument, path /sap/opu/odata/sap/API_BILLING_DOCUMENT_SRV)
//   Business partners:  https://api.sap.com/api/API_BUSINESS_PARTNER/overview        (A_BusinessPartner, A_BusinessPartnerTaxNumber)
//   Sandbox key header: `APIKey` (Business Accelerator Hub, "Show API Key").
//
// How each invoice field is found (the importer needs buyer tax id, due date and an INR amount):
//   buyer         PayerParty (else SoldToParty) is a customer number. A_BusinessPartner is searched by its Customer field for the name.
//   buyer tax id  A_BusinessPartnerTaxNumber of that partner, tax category cfg.taxCategory (default "IN3", the India GSTIN category). Missing: null.
//   due date      A_BillingDocument has NO net-due-date field. So: FixedValueDate if set; else BillingDocumentDate + AdditionalValueDays +
//                 the credit days you give for the document's CustomerPaymentTerms key (cfg.creditDays) or cfg.defaultCreditDays. Else null.
//                 (SAP stores the real due date on the accounting document, not in this service.)
//   amount        TotalNetAmount + TaxAmount in TransactionCurrency, added in minor units.
//   open          not cancelled, not itself a cancellation, InvoiceClearingStatus "A" (to be cleared; "B" part-paid and "C" paid are skipped).
import { ConnectorError, requestJson, str, toMinor, type ErpInvoiceRow } from "./types";

export type SapConfig = {
  /** Host (and prefix), no service path. Sandbox: https://sandbox.api.sap.com/s4hanacloud. Cloud tenant: https://myNNNNNN-api.s4hana.cloud.sap */
  baseUrl: string;
  auth:
    | { kind: "apikey"; apiKey: string }
    | { kind: "basic"; user: string; password: string }
    | { kind: "oauth"; tokenUrl: string; clientId: string; clientSecret: string };
  invoiceTypes?: string[];                    // billing types taken, default ["F2"] (add "ZF2" etc. for your own types)
  taxCategory?: string;                       // BPTaxType holding the GSTIN, default "IN3"
  creditDays?: Record<string, number>;        // CustomerPaymentTerms key (e.g. "NT30") -> net days
  defaultCreditDays?: number;                 // used when the terms key is not in creditDays
  fetch?: typeof fetch;
};

const PAGE = 200;
const MAX_PAGES = 100;   // 20,000 invoices
const KEYS = ["TotalNetAmount", "TaxAmount"];
// OData v2 errors: {"error":{"code":..,"message":{"lang":"en","value":..}}}; token endpoint: {"error":..,"error_description":..}
const errorOf = (b: Record<string, unknown>) => {
  const e = b.error;
  if (typeof e === "string") return `${e}${b.error_description ? `: ${str(b.error_description)}` : ""}`;
  if (e && typeof e === "object") { const m = (e as { message?: unknown }).message; return str(typeof m === "object" ? (m as { value?: unknown })?.value : m) || "error"; }
  return undefined;
};
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`; // OData string literal
const DAY = 86_400_000;
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** OData v2 JSON dates are "/Date(1700000000000)/". Returns UTC ms, or null for blank and for SAP's "initial" dates (before 1900). */
function odataMs(v: unknown): number | null {
  const m = /^\/Date\((-?\d+)/.exec(str(v));
  const ms = m ? Number(m[1]) : /^\d{4}-\d{2}-\d{2}/.test(str(v)) ? Date.parse(str(v).slice(0, 10)) : NaN;
  return Number.isFinite(ms) && ms > -2_208_988_800_000 ? ms : null;
}

export function sapBilling(cfg: SapConfig) {
  const f = cfg.fetch ?? fetch;
  const root = cfg.baseUrl.replace(/\/+$/, "");
  const svc = (name: string) => `${root}/sap/opu/odata/sap/${name}`;
  const types = cfg.invoiceTypes?.length ? cfg.invoiceTypes : ["F2"];

  /** Auth header(s) for one run. OAuth fetches a token first (client credentials, client id and secret sent as HTTP Basic). */
  async function headers(): Promise<Record<string, string>> {
    const h: Record<string, string> = { accept: "application/json" };
    const a = cfg.auth;
    if (a.kind === "apikey") h.APIKey = a.apiKey;
    else if (a.kind === "basic") h.authorization = `Basic ${Buffer.from(`${a.user}:${a.password}`).toString("base64")}`;
    else {
      // UNVERIFIED: client id/secret as Basic auth on the token call is the usual SAP BTP / S/4HANA Cloud way; some tenants want them in the body instead.
      const b = await requestJson(f, "SAP", a.tokenUrl, {
        method: "POST", headers: { authorization: `Basic ${Buffer.from(`${a.clientId}:${a.clientSecret}`).toString("base64")}`, accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
        body: "grant_type=client_credentials",
      }, KEYS, errorOf);
      if (typeof b.access_token !== "string") throw new ConnectorError("SAP did not return an access token; check the OAuth client id, secret and token URL");
      h.authorization = `Bearer ${b.access_token}`;
    }
    return h;
  }

  /** All rows of one entity set, following __next (server paging) or $top/$skip. */
  async function readAll(h: Record<string, string>, service: string, set: string, query: Record<string, string>, max = MAX_PAGES): Promise<Record<string, unknown>[]> {
    const qs = (o: Record<string, string>) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&"); // %20, not "+": SAP Gateway reads it literally
    const out: Record<string, unknown>[] = [];
    let url = `${svc(service)}/${set}?${qs({ ...query, $format: "json", $top: String(PAGE), $skip: "0" })}`;
    for (let n = 0; n < max; n++) {
      const b = await requestJson(f, "SAP", url, { headers: h }, KEYS, errorOf);
      const d = b.d as { results?: unknown; __next?: unknown } | undefined;
      if (!d || !Array.isArray(d.results)) throw new ConnectorError(`SAP sent a ${set} list that could not be read`);
      out.push(...(d.results as Record<string, unknown>[]));
      const next = str(d.__next);
      if (next) url = /^https?:/i.test(next) ? next : `${svc(service)}/${next.replace(/^\/+/, "")}`; // __next may be absolute or relative to the service
      else if (d.results.length >= PAGE) url = `${svc(service)}/${set}?${qs({ ...query, $format: "json", $top: String(PAGE), $skip: String(PAGE * (n + 1)) })}`;
      else return out;
    }
    if (max < MAX_PAGES) return out; // a lookup: the first page is all we want
    throw new ConnectorError("SAP has more invoices than one sync can read; narrow the date range");
  }

  return {
    /**
     * Open invoices. `since` keeps only documents last changed on or after that day (LastChangeDate has day precision, so a day is re-read).
     * Business partners are looked up once per customer: two small calls each (name, then GSTIN).
     */
    async listInvoices(p: { since?: Date } = {}): Promise<ErpInvoiceRow[]> {
      const h = await headers();
      const where = [
        "BillingDocumentIsCancelled eq false",
        `(${types.map((t) => `BillingDocumentType eq ${lit(t)}`).join(" or ")})`,
        ...(p.since ? [`LastChangeDate ge datetime'${p.since.toISOString().slice(0, 10)}T00:00:00'`] : []),
      ].join(" and ");
      const docs = await readAll(h, "API_BILLING_DOCUMENT_SRV", "A_BillingDocument", { $filter: where, $orderby: "BillingDocument" });

      const buyers = new Map<string, { name: string; tax: string | null }>();
      const buyer = async (customer: string) => {
        const hit = buyers.get(customer);
        if (hit) return hit;
        const bp = (await readAll(h, "API_BUSINESS_PARTNER", "A_BusinessPartner", { $filter: `Customer eq ${lit(customer)}`, $select: "BusinessPartner,BusinessPartnerFullName,BusinessPartnerName,OrganizationBPName1" }, 1))[0];
        let tax: string | null = null;
        if (bp) {
          const t = (await readAll(h, "API_BUSINESS_PARTNER", "A_BusinessPartnerTaxNumber", { $filter: `BusinessPartner eq ${lit(str(bp.BusinessPartner))} and BPTaxType eq ${lit(cfg.taxCategory ?? "IN3")}` }, 1))[0];
          tax = str(t?.BPTaxNumber) || str(t?.BPTaxLongNumber) || null;
        }
        const made = { name: str(bp?.BusinessPartnerFullName) || str(bp?.OrganizationBPName1) || str(bp?.BusinessPartnerName) || customer, tax: tax ? tax.toUpperCase() : null };
        buyers.set(customer, made);
        return made;
      };

      const rows: ErpInvoiceRow[] = [];
      for (const raw of docs) {
        const id = str(raw.BillingDocument), currency = str(raw.TransactionCurrency).toUpperCase(), dateMs = odataMs(raw.BillingDocumentDate);
        if (!id || !currency || dateMs === null) throw new ConnectorError(`SAP sent billing document "${id || "?"}" with a missing number, date or currency`);
        // Defence in depth: the $filter already did the first two, so the rules hold even if a server ignores it.
        if (raw.BillingDocumentIsCancelled === true || str(raw.CancelledBillingDocument)) continue;
        if (!types.includes(str(raw.BillingDocumentType))) continue;
        if (str(raw.InvoiceClearingStatus) !== "A") continue; // paid ("C"), part-paid ("B") or not relevant (blank)
        const total = toMinor(str(raw.TotalNetAmount) || "0", currency) + toMinor(str(raw.TaxAmount) || "0", currency);
        if (total === 0n) continue;

        const fixed = odataMs(raw.FixedValueDate);
        const days = cfg.creditDays?.[str(raw.CustomerPaymentTerms)] ?? cfg.defaultCreditDays;
        const due = fixed !== null ? fixed : days === undefined ? null : dateMs + (Number(str(raw.AdditionalValueDays)) || 0) * DAY + days * DAY;

        const customer = str(raw.PayerParty) || str(raw.SoldToParty);
        const b = customer ? await buyer(customer) : { name: "", tax: null };
        rows.push({
          externalId: id, invoiceNumber: id, buyerName: b.name, buyerTaxId: b.tax, invoiceDate: ymd(dateMs),
          dueDate: due === null ? null : ymd(due), amountMinor: total, currency, poReference: str(raw.PurchaseOrderByCustomer) || null,
        });
      }
      return rows;
    },
  };
}

// UNVERIFIED points (could not be checked against a live system or the login-only spec pages):
//  - sandbox base https://sandbox.api.sap.com/s4hanacloud + /sap/opu/odata/sap/<service> (service paths themselves come from the SAP SDK models).
//  - "IN3" as the GSTIN tax category (BPTaxType); override with cfg.taxCategory.
//  - A_BusinessPartner.Customer equals the customer number on the billing document (true when business partners and customers are linked, the S/4HANA default).
//  - the filter literals datetime'...' on LastChangeDate and `BillingDocumentIsCancelled eq false` (standard OData v2 syntax; not run against SAP).
//  - amounts are read at face value; SAP currencies with other than 2 decimals (JPY) store shifted amounts internally, but the OData API is not known to shift them.
