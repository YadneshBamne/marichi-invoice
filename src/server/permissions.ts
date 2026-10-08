// Who inside a company may do what. Platform staff (ops/admin/compliance) have their own checks and are not covered here.
export type OrgRole = "owner" | "manager" | "member";

const ALL: OrgRole[] = ["owner", "manager", "member"];
const LEAD: OrgRole[] = ["owner", "manager"];

export const PERMS = {
  "team.manage": ["owner"],
  "company.edit": ["owner"],
  "apps.manage": ["owner"],
  "invoice.upload": ALL,
  "invoice.view": ALL,
  "buyer.invite": LEAD,
  "offer.answer": LEAD, // accepting an offer is a financial commitment
  "agreement.sign": LEAD,
  "invoice.confirm": LEAD, // a buyer's confirmation is a legal acknowledgement
  "creditnote.issue": LEAD, // changes what the buyer owes
  "offer.reprice": LEAD,
  "bid.place": LEAD, // a bid commits the financier's capital
  "integrations.manage": ["owner"], // API keys and webhooks give outside systems access to the company's data
  "ticket.open": ALL,
} as const satisfies Record<string, OrgRole[]>;
export type Permission = keyof typeof PERMS;

/** Accounts that predate company roles have no orgRole; they are the company's founder, so treat them as owners. */
export const roleOf = (u: { orgRole?: string | null }): OrgRole => (u.orgRole as OrgRole | null) ?? "owner";
export const can = (u: { orgRole?: string | null }, p: Permission) => (PERMS[p] as readonly OrgRole[]).includes(roleOf(u));

export class ForbiddenError extends Error { constructor(p: Permission) { super(`Your role is not allowed to do this (${p}).`); } }
export function assertCan(u: { orgRole?: string | null }, p: Permission) { if (!can(u, p)) throw new ForbiddenError(p); }

export const ORG_ROLE_LABEL: Record<OrgRole, string> = { owner: "Owner", manager: "Manager", member: "Member" };
export const ORG_ROLE_BLURB: Record<OrgRole, string> = {
  owner: "Full control: team, company settings, apps, and every action.",
  manager: "Runs day-to-day finance: accepts offers, signs agreements, links buyers, confirms invoices.",
  member: "Prepares work: uploads and views invoices, raises support requests. Cannot commit the company.",
};
