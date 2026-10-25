// Zoho Books (India and other data centres) connector: pulls a seller's unpaid customer invoices.
// Written from Zoho's public docs:
//   OAuth 2.0:      https://www.zoho.com/books/api/v3/oauth/
//   Data centres:   https://www.zoho.com/books/api/v3/introduction/   (API host www.zohoapis.<dc>/books/v3)
//   Invoices:       https://www.zoho.com/books/api/v3/invoices/       (List invoices, Get an invoice)
// Scope needed: ZohoBooks.invoices.READ. Needs ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET (a "Server-based" client from the Zoho API console).
import { ConnectorError, requestJson, str, isoDay, toMinor, type ErpInvoiceRow, type OAuthTokens } from "./types";

export type ZohoConfig = { clientId: string; clientSecret: string; redirectUri: string; dc: "in" | "com" | "eu"; fetch?: typeof fetch };

const SCOPE = "ZohoBooks.invoices.READ";
const PER_PAGE = 200;   // documented maximum for List invoices
const MAX_PAGES = 100;  // stops a runaway loop: 20,000 invoices
// Money keys quoted before JSON.parse so decimals never pass through a float; invoice_id because Zoho ids can exceed 2^53.
const KEYS = ["total", "balance", "invoice_id"];
const errorOf = (b: Record<string, unknown>) =>
  typeof b.error === "string" ? b.error                                   // token endpoint: {"error":"invalid_code"}
  : typeof b.code === "number" && b.code !== 0 ? `${str(b.message) || "error"} (code ${b.code})` : undefined; // API: {"code":0,"message":"success"}
// Statuses we take. draft and void are never taken; paid and partially paid are not unpaid.
const OPEN = new Set(["sent", "overdue", "viewed", "unpaid"]);

export function zohoBooks(cfg: ZohoConfig) {
  const f = cfg.fetch ?? fetch;
  // UNVERIFIED: accounts.zoho.<dc> for in/com/eu. The docs show accounts.zoho.com and accounts.zoho.eu; .in follows the same pattern.
  const accounts = `https://accounts.zoho.${cfg.dc}`;
  const api = `https://www.zohoapis.${cfg.dc}/books/v3`;

  // UNVERIFIED: the docs show token parameters in the query string; they are sent as a form body here (standard OAuth, keeps the secret out of URLs).
  const token = async (params: Record<string, string>) =>
    requestJson(f, "Zoho", `${accounts}/oauth/v2/token`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, ...params }).toString(),
    }, KEYS, errorOf);

  const call = (path: string, accessToken: string, q: Record<string, string>) =>
    requestJson(f, "Zoho Books", `${api}${path}?${new URLSearchParams(q)}`, { headers: { authorization: `Zoho-oauthtoken ${accessToken}`, accept: "application/json" } }, KEYS, errorOf);

  return {
    /** Send the seller here. access_type=offline + prompt=consent is what makes Zoho return a refresh token. */
    authorizeUrl: (state: string) =>
      `${accounts}/oauth/v2/auth?${new URLSearchParams({ scope: SCOPE, client_id: cfg.clientId, response_type: "code", redirect_uri: cfg.redirectUri, access_type: "offline", prompt: "consent", state })}`,

    /** Swap the one-time code (valid 2 minutes) for tokens. */
    async exchangeCode(code: string): Promise<OAuthTokens> {
      const b = await token({ grant_type: "authorization_code", code, redirect_uri: cfg.redirectUri });
      if (typeof b.access_token !== "string" || typeof b.refresh_token !== "string") throw new ConnectorError("Zoho did not return a refresh token; connect again and accept the permission screen");
      return { accessToken: b.access_token, refreshToken: b.refresh_token, expiresIn: Number(b.expires_in) || 3600 };
    },

    /** A new access token (they last an hour). Zoho keeps the same refresh token, so it is passed back unchanged. */
    async refresh(refreshToken: string): Promise<OAuthTokens> {
      const b = await token({ grant_type: "refresh_token", refresh_token: refreshToken });
      if (typeof b.access_token !== "string") throw new ConnectorError("Zoho did not return an access token; connect Zoho Books again");
      return { accessToken: b.access_token, refreshToken, expiresIn: Number(b.expires_in) || 3600 };
    },

    /**
     * Unpaid invoices (sent, viewed, overdue) in full: partially paid invoices are skipped because the amount to finance would not match.
     * `since` limits to invoices modified after that moment. The list has no GSTIN, so each invoice without one is fetched once
     * (Get an invoice); Zoho allows 100 calls a minute per organisation, so a large first sync may need a retry.
     */
    async listInvoices(p: { accessToken: string; orgId: string; since?: Date }): Promise<ErpInvoiceRow[]> {
      const rows: ErpInvoiceRow[] = [];
      for (let page = 1; page <= MAX_PAGES; page++) {
        const q: Record<string, string> = { organization_id: p.orgId, status: "unpaid", page: String(page), per_page: String(PER_PAGE) };
        // last_modified_time format per docs: YYYY-MM-DDTHH:MM:SS+HHMM, e.g. 2023-11-18T02:02:51-0800
        if (p.since) q.last_modified_time = p.since.toISOString().replace(/\.\d+Z$/, "+0000");
        const b = await call("/invoices", p.accessToken, q);
        if (!Array.isArray(b.invoices)) throw new ConnectorError("Zoho Books sent an invoice list that could not be read");
        for (const raw of b.invoices as Record<string, unknown>[]) {
          const status = str(raw.status).toLowerCase();
          if (!OPEN.has(status)) continue; // UNVERIFIED: status=unpaid is also re-checked here, so the filter holds even if Zoho's "unpaid" is wider
          const currency = str(raw.currency_code).toUpperCase(), number = str(raw.invoice_number), id = str(raw.invoice_id);
          const date = isoDay(raw.date);
          if (!number || !id || !currency || !date) throw new ConnectorError(`Zoho Books sent invoice "${number || id || "?"}" with a missing number, date or currency`);
          const total = toMinor(str(raw.total), currency);
          if (total === 0n || total !== toMinor(str(raw.balance), currency)) continue; // nothing owed, or part-paid
          let gstin = str(raw.gst_no);
          if (!gstin) gstin = str(((await call(`/invoices/${id}`, p.accessToken, { organization_id: p.orgId })).invoice as Record<string, unknown> | undefined)?.gst_no);
          rows.push({
            externalId: id, invoiceNumber: number, buyerName: str(raw.customer_name), buyerTaxId: gstin ? gstin.toUpperCase() : null,
            invoiceDate: date, dueDate: isoDay(raw.due_date), amountMinor: total, currency, poReference: str(raw.reference_number) || null,
          });
        }
        // Docs show page_context as a list in the example, but real replies send an object: accept both.
        const pc = b.page_context; const ctx = (Array.isArray(pc) ? pc[0] : pc) as { has_more_page?: boolean } | undefined;
        if (!ctx?.has_more_page) return rows;
      }
      throw new ConnectorError("Zoho Books has more invoices than one sync can read; narrow the date range");
    },
  };
}
