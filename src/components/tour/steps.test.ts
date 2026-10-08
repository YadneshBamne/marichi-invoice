import { describe, expect, it } from "vitest";
import { ROADMAP } from "../../lib/roadmap";
import { navFor } from "../shell/nav";

const ALL = { picked: ROADMAP.map((r) => r.slug) }; // a company that follows every roadmap module
import { stepsFor } from "./steps";

// Page-level targets live in page code; everything else must be provided by the shell or the role's own nav.
const SHELL = ["workspace", "search", "notifications", "help", "user-menu", "sandbox"];
const PAGE = ["kpis", "setup", "todo", "queues", "nav-soon"]; // nav-soon only exists while the roadmap has entries

const ANY_NAV = new Set(["seller", "buyer", "financier", "ops", "admin"].flatMap((r) => navFor(r, ALL).flatMap((s) => s.items.map((i) => i.tour))));

describe("guided tour", () => {
  for (const role of ["seller", "buyer", "financier", "ops", "compliance", "admin"]) {
    it(`${role}: every required step points at something that exists, and ids are unique`, () => {
      const navIds = new Set(navFor(role, ALL).flatMap((s) => s.items.map((i) => i.tour)).filter(Boolean));
      const steps = stepsFor(role, "Asha");
      expect(new Set(steps.map((s) => s.id)).size).toBe(steps.length);
      for (const s of steps) {
        if (!s.target || s.optional) continue;
        expect(navIds.has(s.target) || SHELL.includes(s.target), `${role}: step "${s.id}" targets "${s.target}"`).toBe(true);
      }
      for (const s of steps.filter((x) => x.optional)) expect(ANY_NAV.has(s.target!) || SHELL.includes(s.target!) || PAGE.includes(s.target!), `${role}: optional "${s.id}"`).toBe(true);
      expect(steps[0].id).toBe("welcome"); expect(steps.at(-1)!.id).toBe("done");
    });
  }
});
