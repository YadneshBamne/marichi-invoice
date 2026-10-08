// Product roadmap (PRD Phases 2 and 3). Drives the "Coming soon" sidebar group and the /soon/[slug] pages.
// No dates are promised here on purpose: phase only.
export type RoleName = "seller" | "buyer" | "financier" | "admin" | "ops" | "compliance";
export type Planned = {
  slug: string; title: string; short: string; icon: string; phase: 2 | 3; roles: RoleName[]; summary: string; bullets: string[];
};

const STAFF: RoleName[] = ["admin", "ops", "compliance"];

export const ROADMAP: Planned[] = [
  {
    slug: "analytics", short: "Analytics", title: "Advanced analytics", icon: "trend", phase: 3, roles: ["seller", "buyer", "financier", ...STAFF],
    summary: "Deeper reporting and forecasting across your invoices, cash flow and portfolio.",
    bullets: ["Cohort, vintage and concentration analysis", "Cash-flow forecasting from open invoices", "Scheduled and exportable reports", "Role-specific views for sellers, buyers and staff"],
  },
  {
    slug: "cross-border", short: "Cross-border", title: "Cross-border financing", icon: "globe", phase: 3, roles: ["seller", ...STAFF],
    summary: "Finance export invoices raised on overseas buyers, in the currency you invoice in.",
    bullets: ["Multi-currency invoices and settlement", "Foreign-buyer verification", "FX and compliance handling", "Same offer and repayment experience"],
  },
];

export const roadmapFor = (role: string) => ROADMAP.filter((p) => p.roles.includes(role as RoleName));
export const roadmapItem = (slug: string) => ROADMAP.find((p) => p.slug === slug);
