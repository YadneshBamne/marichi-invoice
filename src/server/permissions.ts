// Who inside a company may do what. Platform staff (ops/admin/compliance) have their own checks and are not covered here.
//
// Principles (see docs/PLATFORM-GUIDE.md section 3):
//  - one owner; a few fixed roles;
//  - managing people is separate from moving money: an Admin can run the team but cannot commit company money;
//  - a Maker prepares, an Approver commits, and nobody approves their own request when a second approver is required.
export type OrgRole = "owner" | "admin" | "approver" | "maker" | "viewer";

const ALL: OrgRole[] = ["owner", "admin", "approver", "maker", "viewer"];
const WORK: OrgRole[] = ["owner", "approver", "maker"]; // people who prepare work
const COMMIT: OrgRole[] = ["owner", "approver"]; // people who may commit company money
const PEOPLE: OrgRole[] = ["owner", "admin"];

export const PERMS = {
  // people and company
  "team.manage": PEOPLE, // invite, suspend, change maker/viewer access
  "team.grant": ["owner"], // give or take away approver and admin access: this is money power, so only the owner
  "company.edit": PEOPLE,
  "apps.manage": PEOPLE,
  "integrations.manage": PEOPLE, // API keys and webhooks give outside systems access to the company's data
  "approval.settings": ["owner"], // dual control on or off
  "approval.decide": COMMIT,
  // preparing work
  "invoice.upload": WORK,
  "invoice.view": ALL,
  "buyer.invite": WORK,
  "offer.reprice": WORK,
  "offer.prepare": WORK, // a maker submits an acceptance for approval
  "bid.prepare": WORK,
  "earlypay.prepare": WORK,
  "ticket.open": ["owner", "admin", "approver", "maker"],
  // committing money or the company's name
  "offer.answer": COMMIT, // accepting an offer or a bid is a financial commitment
  "agreement.sign": COMMIT,
  "invoice.confirm": COMMIT, // a buyer's confirmation is a legal acknowledgement
  "creditnote.issue": COMMIT, // changes what the buyer owes
  "bid.place": COMMIT,
  "earlypay.propose": COMMIT,
  "programme.manage": COMMIT,
  "programme.join": COMMIT,
} as const satisfies Record<string, OrgRole[]>;
export type Permission = keyof typeof PERMS;

/** Accounts that predate company roles have no orgRole; they are the company's founder, so treat them as owners. */
export const roleOf = (u: { orgRole?: string | null }): OrgRole => (u.orgRole as OrgRole | null) ?? "owner";
export const can = (u: { orgRole?: string | null }, p: Permission) => (PERMS[p] as readonly OrgRole[]).includes(roleOf(u));

export class ForbiddenError extends Error { constructor(p: Permission) { super(`Your role is not allowed to do this (${p}).`); } }
export function assertCan(u: { orgRole?: string | null }, p: Permission) { if (!can(u, p)) throw new ForbiddenError(p); }

export const ORG_ROLES = ["owner", "admin", "approver", "maker", "viewer"] as const;
/** Roles an invitation can grant. There is exactly one owner, so "owner" is never invitable. */
export const INVITABLE: readonly OrgRole[] = ["admin", "approver", "maker", "viewer"];
/** Roles that carry money or admin power. Only the owner may hand these out. */
export const POWERFUL: readonly OrgRole[] = ["admin", "approver"];

export const ORG_ROLE_LABEL: Record<OrgRole, string> = { owner: "Owner", admin: "Admin", approver: "Approver", maker: "Maker", viewer: "Viewer" };
export const ORG_ROLE_BLURB: Record<OrgRole, string> = {
  owner: "Full control. The only person who can hand out approver or admin access, switch dual control, transfer ownership or close the company.",
  admin: "Runs the team and company settings. Cannot commit company money.",
  approver: "Commits company money: accepts offers, signs agreements, approves other people's requests. Never their own, when a second approver is required.",
  maker: "Prepares the work: uploads invoices, links buyers, drafts requests. An approver decides before anything binding happens.",
  viewer: "Read-only. Suited to an accountant or auditor.",
};
