import { APPS, followed } from "../../lib/apps";
import { ROADMAP } from "../../lib/roadmap";

// One place to add a screen. `tour` is the data-tour id the guided tour points at.
export type Item = { href: string; label: string; icon: string; tour?: string; soon?: boolean; phase?: number };
export type Section = { label: string; items: Item[] };

const SETTINGS: Item = { href: "/settings", label: "Settings", icon: "gear", tour: "nav-settings" };

const STAFF: Section[] = [
  { label: "Operations", items: [
    { href: "/admin", label: "Overview", icon: "home", tour: "nav-dashboard" },
    { href: "/admin/kyb", label: "KYB review", icon: "shield", tour: "nav-kyb" },
    { href: "/admin/underwriting", label: "Underwriting", icon: "scale", tour: "nav-underwriting" },
    { href: "/admin/disbursements", label: "Disbursements", icon: "coins", tour: "nav-disbursements" },
    { href: "/admin/collections", label: "Collections", icon: "bank", tour: "nav-collections" },
    { href: "/admin/financiers", label: "Financiers", icon: "handshake", tour: "nav-financiers" },
  ] },
  { label: "Risk & finance", items: [
    { href: "/admin/fraud", label: "Fraud cases", icon: "alert", tour: "nav-fraud" },
    { href: "/admin/models", label: "Model monitor", icon: "target", tour: "nav-models" },
    { href: "/admin/ledger", label: "Ledger", icon: "chart", tour: "nav-ledger" },
    { href: "/admin/support", label: "Support queue", icon: "help", tour: "nav-support" },
  ] },
];
const ADMIN_ONLY: Section = { label: "Administration", items: [
  { href: "/admin/users", label: "Users & roles", icon: "users", tour: "nav-users" },
  { href: "/admin/audit", label: "Audit log", icon: "scale", tour: "nav-audit" },
  { href: "/admin/policy", label: "Policy", icon: "scale", tour: "nav-policy" },
  { href: "/admin/system", label: "System health", icon: "gear", tour: "nav-system" },
] };

export type NavOpts = { apps?: Iterable<string>; picked?: string[]; orgRole?: string };

/**
 * Sidebar for a role. Company users see Dashboard + the apps their owner switched on (+ followed roadmap items);
 * owners also get Apps and Team. Platform staff get their fixed console.
 */
export function navFor(role: string, o: NavOpts = {}): Section[] {
  if (role === "admin") return [...STAFF, ADMIN_ONLY, { label: "Account", items: [SETTINGS] }];
  if (role === "ops" || role === "compliance") return [...STAFF, { label: "Account", items: [SETTINGS] }];

  const on = new Set(o.apps ?? APPS.filter((a) => a.core || a.default).map((a) => a.id)); // default view = core + default apps
  const owner = (o.orgRole ?? "owner") === "owner";
  const workspace: Item[] = [{ href: "/dashboard", label: "Dashboard", icon: "home", tour: "nav-dashboard" }];
  const account: Item[] = [];
  for (const a of APPS) {
    if (!on.has(a.id) || !a.types.includes(role as never)) continue;
    for (const n of a.nav ?? []) (a.id === "support" ? account : workspace).push(n);
  }
  if (owner) account.push({ href: "/apps", label: "Apps", icon: "layers", tour: "nav-apps" }, { href: "/settings/team", label: "Team", icon: "users", tour: "nav-team" });
  account.push(SETTINGS);

  const soon = followed(o.picked ?? [])
    .map((slug) => ROADMAP.find((r) => r.slug === slug))
    .filter((p): p is NonNullable<typeof p> => !!p && p.roles.includes(role as never))
    .map((p, n) => ({ href: `/soon/${p.slug}`, label: p.short, icon: p.icon, soon: true, phase: p.phase, tour: n === 0 ? "nav-soon" : undefined }));

  return [{ label: "Workspace", items: workspace }, ...(soon.length ? [{ label: "Coming soon", items: soon }] : []), { label: "Account", items: account }];
}

export const ROLE_META: Record<string, { label: string; workspace: string; blurb: string; home: string }> = {
  seller: { label: "Seller", workspace: "Seller workspace", blurb: "Get paid on your invoices sooner", home: "/dashboard" },
  buyer: { label: "Buyer", workspace: "Buyer workspace", blurb: "Confirm invoices and manage payables", home: "/dashboard" },
  financier: { label: "Financier", workspace: "Financier workspace", blurb: "Deploy capital against verified invoices", home: "/dashboard" },
  ops: { label: "Operations", workspace: "Operations console", blurb: "Run the daily queues", home: "/admin" },
  compliance: { label: "Compliance", workspace: "Compliance console", blurb: "Risk, AML and regulatory work", home: "/admin" },
  admin: { label: "Administrator", workspace: "Admin console", blurb: "Operate and govern the platform", home: "/admin" },
};

/** Path -> breadcrumb label for the segments that aren't obvious from the URL. */
export const CRUMBS: Record<string, string> = {
  admin: "Console", seller: "Seller", buyer: "Buyer", kyb: "KYB review", underwriting: "Underwriting", disbursements: "Disbursements",
  collections: "Collections", fraud: "Fraud cases", ledger: "Ledger", support: "Support", users: "Users & roles", audit: "Audit log",
  system: "System health", policy: "Policy", models: "Model monitor", invoices: "Invoices", buyers: "Buyers", agreements: "Agreements", settings: "Settings", dashboard: "Dashboard",
  onboarding: "Verification", soon: "Coming soon", notifications: "Notifications", profile: "Profile", security: "Security", organization: "Company",
  apps: "Apps", team: "Team", financier: "Financier", financiers: "Financiers", deals: "Deal flow", bids: "My bids", portfolio: "Portfolio", statement: "Statement",
};
