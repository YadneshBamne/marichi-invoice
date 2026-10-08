import { redirect } from "next/navigation";
import { requireUser } from "@/server/rbac";
import { appsFor } from "@/lib/apps";
import { roadmapFor } from "@/lib/roadmap";
import { SetupWizard } from "./wizard";

export const metadata = { title: "Set up your company" };

export default async function Setup() {
  const u = await requireUser(["seller", "buyer", "financier"], { skipSetup: true });
  if (!u.biz || u.orgRole !== "owner" || u.biz.setupCompletedAt) redirect("/dashboard");
  const catalog = appsFor(u.role).map(({ id, name, icon, blurb, core, default: d }) => ({ id, name, icon, blurb, core: !!core, on: !!(core || d) }));
  const soon = roadmapFor(u.role).map((r) => ({ slug: r.slug, title: r.title, icon: r.icon, phase: r.phase, summary: r.summary }));
  const picked = u.biz.apps.length ? u.biz.apps : catalog.filter((a) => a.on).map((a) => a.id);
  return <SetupWizard type={u.role} firstName={u.name.split(" ")[0]} legalName={u.biz.displayName ?? u.biz.legalName} hasLogo={!!u.biz.logoRef} catalog={catalog} soon={soon} picked={picked} />;
}
