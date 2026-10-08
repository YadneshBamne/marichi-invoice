// Product roadmap (PRD Phases 2 and 3). Drives the "Coming soon" sidebar group and the /soon/[slug] pages.
// No dates are promised here on purpose: phase only.
export type RoleName = "seller" | "buyer" | "financier" | "admin" | "ops" | "compliance";
export type Planned = {
  slug: string; title: string; short: string; icon: string; phase: 2 | 3; roles: RoleName[]; summary: string; bullets: string[];
};

// Everything in the PRD's Phase 2 and 3 is built, so nothing is planned right now. Add entries here to bring the "Coming soon" group back.
export const ROADMAP: Planned[] = [];

export const roadmapFor = (role: string) => ROADMAP.filter((p) => p.roles.includes(role as RoleName));
export const roadmapItem = (slug: string) => ROADMAP.find((p) => p.slug === slug);
