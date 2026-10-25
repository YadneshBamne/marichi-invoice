// QuickBooks Online connector: pulls a seller's unpaid customer invoices.
// Written from Intuit's public docs:
//   OAuth 2.0 endpoints (official discovery document): https://developer.api.intuit.com/.well-known/openid_configuration
//   OAuth 2.0 guide:  https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0
//   Query + paging:   https://developer.intuit.com/app/developer/qbo/docs/learn/explore-the-quickbooks-online-api/data-queries
//   Invoice entity:   https://developer.intuit.com/app/developer/qbo/docs/api/accounting/most-commonly-used/invoice
// Scope: com.intuit.quickbooks.accounting. Needs QBO_CLIENT_ID / QBO_CLIENT_SECRET and the realmId (company id) that Intuit adds to the redirect.
//
// QuickBooks has NO tax-registration field on an invoice or customer that India's GSTIN fits. So the buyer GSTIN is read from an
// INVOICE CUSTOM FIELD whose name you configure (cfg.taxIdField, default "Buyer GSTIN"), created under Sales settings > Custom fields.
// The PO number is read the same way (cfg.poField, default "P.O. Number"). A QuickBooks invoice has no draft state, so "unpaid" means balance owed.
import { ConnectorError, requestJson, str, isoDay, toMinor, type ErpInvoiceRow, type OAuthTokens } from "./types";

export type QuickBooksConfig = {
  clientId: string; clientSecret: string; redirectUri: string; env: "sandbox" | "production";
  taxIdField?: string; poField?: string;
  defaultCurrency?: string;   // used only if an invoice carries no CurrencyRef (single-currency companies)
  minorVersion?: number; fetch?: typeof fetch;
};

const AUTH = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer"; // same for sandbox and production
const PAGE = 1000;       // documented maximum for MAXRESULTS
const MAX_PAGES = 50;    // 50,000 invoices
const KEYS = ["TotalAmt", "Balance"];
// Intuit errors: {"Fault":{"Error":[{"Message":..,"Detail":..}]}} from the API, {"error":..,"error_description":..} from the token endpoint.
const errorOf = (b: Record<string, unknown>) => {
  const e = ((b.Fault as { Error?: { Message?: string; Detail?: string }[] } | undefined)?.Error ?? [])[0];
  if (e) return [e.Message, e.Detail].filter(Boolean).join(": ");
  return typeof b.error === "string" ? `${b.error}${b.error_description ? `: ${b.error_description}` : ""}` : undefined;
};

export function quickbooks(cfg: QuickBooksConfig) {
  const f = cfg.fetch ?? fetch;
  const api = cfg.env === "production" ? "https://quickbooks.api.intuit.com" : "https://sandbox-quickbooks.api.intuit.com";
  const taxField = (cfg.taxIdField ?? "Buyer GSTIN").toLowerCase(), poField = (cfg.poField ?? "P.O. Number").toLowerCase();
  const basic = `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64")}`;

  const token = async (params: Record<string, string>): Promise<OAuthTokens> => {
    const b = await requestJson(f, "QuickBooks", TOKEN, {
      method: "POST", headers: { authorization: basic, accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    }, KEYS, errorOf);
    if (typeof b.access_token !== "string" || typeof b.refresh_token !== "string") throw new ConnectorError("QuickBooks did not return tokens; connect again");
    return { accessToken: b.access_token, refreshToken: b.refresh_token, expiresIn: Number(b.expires_in) || 3600 };
  };

  return {
    /** Send the seller here. The redirect brings back code, state and realmId: keep the realmId, it names the company. */
    authorizeUrl: (state: string) =>
      `${AUTH}?${new URLSearchParams({ client_id: cfg.clientId, scope: "com.intuit.quickbooks.accounting", redirect_uri: cfg.redirectUri, response_type: "code", state })}`,

    exchangeCode: (code: string) => token({ grant_type: "authorization_code", code, redirect_uri: cfg.redirectUri }),

    /** Intuit may issue a NEW refresh token with every refresh: always store the one returned. */
    refresh: (refreshToken: string) => token({ grant_type: "refresh_token", refresh_token: refreshToken }),

    /** Invoices that still have their whole total owed (voided and paid ones have a zero balance; part-paid ones are skipped). */
    async listInvoices(p: { accessToken: string; realmId: string; since?: Date }): Promise<ErpInvoiceRow[]> {
      const rows: ErpInvoiceRow[] = [];
      // UNVERIFIED: filtering a query on MetaData.LastUpdatedTime and its timestamp format (the change-data-capture docs use this field).
      const where = p.since ? ` WHERE MetaData.LastUpdatedTime > '${p.since.toISOString().replace(/\.\d+Z$/, "+00:00")}'` : "";
      for (let n = 0, start = 1; n < MAX_PAGES; n++, start += PAGE) {
        const query = `SELECT * FROM Invoice${where} STARTPOSITION ${start} MAXRESULTS ${PAGE}`;
        // UNVERIFIED: minorversion 75 is the current floor as far as we know; override with cfg.minorVersion.
        const q = new URLSearchParams({ query, minorversion: String(cfg.minorVersion ?? 75) });
        const b = await requestJson(f, "QuickBooks", `${api}/v3/company/${encodeURIComponent(p.realmId)}/query?${q}`, { headers: { authorization: `Bearer ${p.accessToken}`, accept: "application/json" } }, KEYS, errorOf);
        const qr = b.QueryResponse as { Invoice?: Record<string, unknown>[] } | undefined;
        if (!qr || typeof qr !== "object") throw new ConnectorError("QuickBooks sent an invoice list that could not be read");
        const page = qr.Invoice ?? []; // an empty page has no Invoice key at all
        if (!Array.isArray(page)) throw new ConnectorError("QuickBooks sent an invoice list that could not be read");
        for (const raw of page) {
          const number = str(raw.DocNumber), id = str(raw.Id), date = isoDay(raw.TxnDate);
          const currency = (str((raw.CurrencyRef as { value?: unknown } | undefined)?.value) || cfg.defaultCurrency || "").toUpperCase();
          if (!id || !date || !currency) throw new ConnectorError(`QuickBooks sent invoice "${number || id || "?"}" with a missing id, date or currency`);
          if (!number) continue; // numbering switched off: nothing to identify it by
          const total = toMinor(str(raw.TotalAmt), currency);
          if (total === 0n || total !== toMinor(str(raw.Balance), currency)) continue; // void, paid or part-paid
          const field = (name: string) => {
            const cf = Array.isArray(raw.CustomField) ? (raw.CustomField as Record<string, unknown>[]).find((c) => str(c.Name).toLowerCase() === name) : undefined;
            return str(cf?.StringValue);
          };
          const gstin = field(taxField);
          rows.push({
            externalId: id, invoiceNumber: number, buyerName: str((raw.CustomerRef as { name?: unknown } | undefined)?.name), buyerTaxId: gstin ? gstin.toUpperCase() : null,
            invoiceDate: date, dueDate: isoDay(raw.DueDate), amountMinor: total, currency, poReference: field(poField) || null,
          });
        }
        if (page.length < PAGE) return rows;
      }
      throw new ConnectorError("QuickBooks has more invoices than one sync can read; narrow the date range");
    },
  };
}
