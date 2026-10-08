// Support SLAs and the escalation matrix (PRD Module 16). Calendar hours, not business hours.
// ponytail: move to the admin console (Module 15) config when support wants to tune them.
export type Kind = "query" | "complaint" | "dispute" | "grievance";
export const KINDS: Kind[] = ["query", "complaint", "dispute", "grievance"];

export const SLA_HOURS: Record<Kind, { firstResponse: number; resolve: number }> = {
  query: { firstResponse: 24, resolve: 72 },
  complaint: { firstResponse: 24, resolve: 7 * 24 },
  dispute: { firstResponse: 24, resolve: 5 * 24 },
  grievance: { firstResponse: 24, resolve: 30 * 24 }, // RBI: resolve within 30 days, else the customer may go to the Ombudsman
};

export const MAX_LEVEL = 3;
/** Who may work a ticket at each level. L1 support, L2 relationship manager (admin), L3 credit/compliance. */
export type StaffRole = "ops" | "admin" | "compliance";
export const LEVEL_ROLES: Record<number, StaffRole[]> = { 1: ["ops", "admin"], 2: ["admin"], 3: ["compliance", "admin"] };
export const STAFF_ROLES: StaffRole[] = ["ops", "admin", "compliance"];

export const canWork = (role: string, level: number) => (LEVEL_ROLES[level] ?? []).includes(role as StaffRole);

export const slaDates = (kind: Kind, now: Date) => ({
  firstResponseDueAt: new Date(now.getTime() + SLA_HOURS[kind].firstResponse * 3_600_000),
  resolveDueAt: new Date(now.getTime() + SLA_HOURS[kind].resolve * 3_600_000),
});

export const ticketNo = (seq: number) => `TKT-${String(seq).padStart(6, "0")}`;
