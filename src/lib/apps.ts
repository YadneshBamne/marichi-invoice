// Company apps, Odoo-style: the owner switches on what the company uses. Core apps are always on.
// Roadmap modules can be "followed" so they appear in the sidebar as coming soon.
import { ROADMAP } from "./roadmap";

export type CompanyType = "seller" | "buyer" | "financier";
export type AppDef = { id: string; name: string; icon: string; blurb: string; types: CompanyType[]; core?: boolean; default?: boolean; nav?: { href: string; label: string; icon: string; tour?: string }[] };

export const APPS: AppDef[] = [
  {
    id: "invoicing", name: "Invoice financing", icon: "invoice", types: ["seller"], core: true,
    blurb: "Upload invoices, link buyers, review offers and sign agreements. Everything needed to get paid early.",
    nav: [
      { href: "/seller/invoices", label: "Invoices", icon: "invoice", tour: "nav-invoices" },
      { href: "/seller/buyers", label: "Buyers", icon: "users", tour: "nav-buyers" },
      { href: "/seller/agreements", label: "Agreements", icon: "file", tour: "nav-agreements" },
    ],
  },
  {
    id: "confirmations", name: "Invoice confirmations", icon: "check", types: ["buyer"], core: true,
    blurb: "Confirm or dispute invoices from your suppliers and see what you owe and when.",
    nav: [{ href: "/buyer/invoices", label: "Invoices", icon: "invoice", tour: "nav-invoices" }],
  },
  {
    id: "marketplace", name: "Marketplace", icon: "layers", types: ["financier"], core: true,
    blurb: "See approved invoices, bid to fund them, and follow what you have funded, what came back and what it earned.",
    nav: [
      { href: "/financier/deals", label: "Deal flow", icon: "layers", tour: "nav-deals" },
      { href: "/financier/bids", label: "My bids", icon: "handshake", tour: "nav-bids" },
      { href: "/financier/portfolio", label: "Portfolio", icon: "chart", tour: "nav-portfolio" },
      { href: "/financier/statement", label: "Statement", icon: "receipt", tour: "nav-statement" },
    ],
  },
  {
    id: "support", name: "Support desk", icon: "help", types: ["seller", "buyer", "financier"], default: true,
    blurb: "Raise queries, complaints and grievances, and follow each by ticket with response times.",
    nav: [{ href: "/support", label: "Support", icon: "help", tour: "nav-support" }],
  },
  {
    id: "integrations", name: "ERP and accounting sync", icon: "plug", types: ["seller", "buyer"],
    blurb: "Connect your accounting system: API keys, CSV import, and webhooks that push status changes back to you.",
    nav: [{ href: "/settings/integrations", label: "Integrations", icon: "plug", tour: "nav-integrations" }],
  },
  {
    id: "exports", name: "Reports and exports", icon: "download", types: ["seller", "buyer"], default: true,
    blurb: "Download your invoices and settlement data as CSV for your accountant.",
  },
];

export const appsFor = (type: string) => APPS.filter((a) => a.types.includes(type as CompanyType));
const SOON_IDS = new Set(ROADMAP.map((r) => r.slug));

/** What is actually switched on: core apps plus the owner's valid picks. Unknown or foreign ids are ignored. */
export function enabledApps(type: string, picked: string[]) {
  const mine = appsFor(type);
  const ids = new Set(mine.filter((a) => a.core).map((a) => a.id));
  for (const a of mine) if (picked.includes(a.id)) ids.add(a.id);
  return ids;
}
/** Until the owner has run the setup wizard, the default apps count as picked, so nobody loses Support or exports in the meantime. */
export const effectivePicks = (b: { apps: string[]; setupCompletedAt: Date | null }, type: string) =>
  b.setupCompletedAt ? b.apps : [...new Set([...appsFor(type).filter((a) => a.default).map((a) => a.id), ...b.apps])];

/** Roadmap modules the owner follows (shown in the sidebar as coming soon). */
export const followed = (picked: string[]) => picked.filter((p) => SOON_IDS.has(p));

/** Clean a submitted selection down to ids that exist for this company type. */
export function cleanSelection(type: string, picked: string[]) {
  const ok = new Set([...appsFor(type).map((a) => a.id), ...SOON_IDS]);
  return [...new Set(picked.filter((p) => ok.has(p)))];
}
