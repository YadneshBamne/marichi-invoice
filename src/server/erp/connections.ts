// A seller's link to an accounting system: connect once (OAuth), then import its unpaid invoices whenever asked. The refresh token is stored
// encrypted. Each import goes through the same checks as the CSV import; invoices already imported are skipped, not reported as errors.
import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { auditLog, erpConnections, invoices } from "../db/schema";
import { appUrl } from "../notify";
import { zohoBooks } from "./connectors/zoho-books";
import { quickbooks } from "./connectors/quickbooks";
import { ConnectorError, type ErpInvoiceRow, type OAuthTokens } from "./connectors/types";
import { importErpRows } from "./connectors/import";

export const PROVIDERS = { zoho: "Zoho Books", quickbooks: "QuickBooks" } as const;
export type Provider = keyof typeof PROVIDERS;
export const isProvider = (p: string): p is Provider => p in PROVIDERS;

/** What the screens need from a provider, whatever its API looks like. */
export type Accounting = {
  label: string;
  authorizeUrl(state: string): string;
  /** Swap the one-time code for tokens and say which company or organisation it is for. `callback` has whatever else the redirect carried (QuickBooks: realmId). */
  connect(code: string, callback: Record<string, string>): Promise<{ tokens: OAuthTokens; org: string }>;
  refresh(refreshToken: string): Promise<OAuthTokens>;
  list(accessToken: string, org: string): Promise<ErpInvoiceRow[]>;
};

/** The connector for a provider, or null when this deployment has no keys for it. */
export function accountingFor(provider: Provider, env: Record<string, string | undefined> = process.env, base = appUrl()): Accounting | null {
  if (provider === "zoho") {
    if (!env.ZOHO_CLIENT_ID || !env.ZOHO_CLIENT_SECRET) return null;
    const dc = env.ZOHO_DC === "com" || env.ZOHO_DC === "eu" ? env.ZOHO_DC : "in";
    const z = zohoBooks({ clientId: env.ZOHO_CLIENT_ID, clientSecret: env.ZOHO_CLIENT_SECRET, dc, redirectUri: `${base}/api/erp/zoho/callback` });
    return {
      label: PROVIDERS.zoho, authorizeUrl: z.authorizeUrl, refresh: z.refresh, list: (accessToken, org) => z.listInvoices({ accessToken, orgId: org }),
      async connect(code) {
        const tokens = await z.exchangeCode(code);
        const orgs = await z.organizations(tokens.accessToken);
        if (!orgs.length) throw new ConnectorError("that Zoho login has no Zoho Books organisation");
        return { tokens, org: orgs[0].id }; // ponytail: the first organisation; add a picker when someone has several
      },
    };
  }
  if (!env.QBO_CLIENT_ID || !env.QBO_CLIENT_SECRET) return null;
  const q = quickbooks({ clientId: env.QBO_CLIENT_ID, clientSecret: env.QBO_CLIENT_SECRET, env: env.QBO_ENV === "production" ? "production" : "sandbox", redirectUri: `${base}/api/erp/quickbooks/callback` });
  return {
    label: PROVIDERS.quickbooks, authorizeUrl: q.authorizeUrl, refresh: q.refresh, list: (accessToken, org) => q.listInvoices({ accessToken, realmId: org }),
    async connect(code, callback) {
      if (!callback.realmId) throw new ConnectorError("QuickBooks did not say which company was connected; try again");
      return { tokens: await q.exchangeCode(code), org: callback.realmId };
    },
  };
}

export const connectionOf = async (db: Database, businessId: string, provider: Provider) =>
  (await db.select().from(erpConnections).where(and(eq(erpConnections.businessId, businessId), eq(erpConnections.provider, provider))))[0] ?? null;

/** Store (or replace) the link after the seller has agreed on the provider's screen. */
export async function saveConnection(db: Database, p: { businessId: string; userId: string; provider: Provider; code: string; callback?: Record<string, string>; accounting?: Accounting | null }, now = new Date()) {
  const a = p.accounting ?? accountingFor(p.provider);
  if (!a) throw new ConnectorError(`${PROVIDERS[p.provider]} is not set up on this platform`);
  const { tokens, org } = await a.connect(p.code, p.callback ?? {});
  await db.insert(erpConnections).values({ businessId: p.businessId, provider: p.provider, externalOrg: org, refreshToken: tokens.refreshToken, connectedBy: p.userId, createdAt: now })
    .onConflictDoUpdate({ target: [erpConnections.businessId, erpConnections.provider], set: { externalOrg: org, refreshToken: tokens.refreshToken, status: "active", connectedBy: p.userId, lastSyncNote: null } });
  await db.insert(auditLog).values({ actorId: p.userId, action: "erp.connect", entity: "business", entityId: p.businessId, after: { provider: p.provider } });
}

export async function disconnect(db: Database, p: { businessId: string; userId: string; provider: Provider }) {
  await db.delete(erpConnections).where(and(eq(erpConnections.businessId, p.businessId), eq(erpConnections.provider, p.provider)));
  await db.insert(auditLog).values({ actorId: p.userId, action: "erp.disconnect", entity: "business", entityId: p.businessId, after: { provider: p.provider } });
}

/**
 * Pull the open invoices and import them (or, with dryRun, only say what would happen). Invoices already on the platform are left out and
 * counted. An expired or revoked link marks the connection so the screen can ask the seller to connect again.
 */
export async function syncConnection(db: Database, businessId: string, provider: Provider, opts: { dryRun?: boolean; accounting?: Accounting | null; now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const conn = await connectionOf(db, businessId, provider);
  if (!conn) throw new ConnectorError(`${PROVIDERS[provider]} is not connected`);
  const a = opts.accounting ?? accountingFor(provider);
  if (!a) throw new ConnectorError(`${PROVIDERS[provider]} is not set up on this platform`);
  let rows: ErpInvoiceRow[];
  try {
    const tokens = await a.refresh(conn.refreshToken);
    // QuickBooks may hand out a new refresh token each time: keep the latest.
    if (tokens.refreshToken !== conn.refreshToken) await db.update(erpConnections).set({ refreshToken: tokens.refreshToken }).where(eq(erpConnections.id, conn.id));
    rows = await a.list(tokens.accessToken, conn.externalOrg ?? "");
  } catch (e) {
    const gone = e instanceof ConnectorError && (e.status === 400 || e.status === 401);
    await db.update(erpConnections).set({ ...(gone ? { status: "expired" } : {}), lastSyncNote: (e as Error).message }).where(eq(erpConnections.id, conn.id));
    throw e;
  }
  const have = new Set((await db.select({ n: invoices.invoiceNumber }).from(invoices).where(eq(invoices.sellerId, businessId))).map((x) => x.n));
  const fresh = rows.filter((r) => !have.has(r.invoiceNumber));
  const skipped = rows.length - fresh.length;
  const result = fresh.length ? await importErpRows(db, businessId, fresh, { dryRun: opts.dryRun }) : { results: [], imported: 0, valid: 0, invalid: 0 };
  if (!opts.dryRun) {
    const note = `${result.imported} imported, ${result.invalid} could not be, ${skipped} already on the platform`;
    await db.update(erpConnections).set({ lastSyncAt: now, lastSyncNote: note, status: "active" }).where(eq(erpConnections.id, conn.id));
    await db.insert(auditLog).values({ action: "erp.sync", entity: "business", entityId: businessId, after: { provider, imported: result.imported, invalid: result.invalid, skipped } });
  }
  return { ...result, skipped, found: rows.length };
}
