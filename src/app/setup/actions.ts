"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/server/db/client";
import { requireUser } from "@/server/rbac";
import { completeSetup, setApps, setCompanyLogo, updateCompany } from "@/server/company/service";
import { inviteMember } from "@/server/company/invitations";
import { ORG_ROLES } from "@/server/permissions";

export type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

// Actions return errors instead of throwing, so the wizard can show them inline rather than hitting an error page.
async function guarded<T>(fn: (actor: { id: string; role: string; orgRole: string; businessId: string | null }) => Promise<T>): Promise<Result<T extends object ? T : object>> {
  const u = await requireUser(["seller", "buyer", "financier"], { skipSetup: true });
  try { return { ok: true, ...((await fn({ id: u.id, role: u.role, orgRole: u.orgRole, businessId: u.businessId })) as object) } as never; }
  catch (e) { return { ok: false, error: e instanceof Error ? e.message : "Something went wrong." }; }
}

export async function saveApps(picks: string[]) {
  return guarded(async (a) => { await setApps(db, a, z.array(z.string()).parse(picks)); return {}; });
}

export async function saveProfile(fd: FormData) {
  return guarded(async (a) => {
  await updateCompany(db, a, { displayName: String(fd.get("name") ?? ""), phone: String(fd.get("phone") ?? ""), city: String(fd.get("city") ?? ""), industry: String(fd.get("industry") ?? "") });
  const logo = fd.get("logo");
  if (logo instanceof File && logo.size > 0) await setCompanyLogo(db, a, Buffer.from(await logo.arrayBuffer()), logo.type);
  return {};
  });
}

export async function inviteTeamMember(p: { email: string; orgRole: string }) {
  return guarded(async (a) => {
    const f = z.object({ email: z.email("Enter a valid email address."), orgRole: z.enum(ORG_ROLES).exclude(["owner"]) }).parse(p);
    const r = await inviteMember(db, a, f);
    return { email: f.email.toLowerCase(), emailed: r.emailed };
  });
}

export async function finishSetup() {
  const r = await guarded(async (a) => { await completeSetup(db, a); return {}; });
  if (!r.ok) return r;
  revalidatePath("/", "layout");
  redirect("/dashboard");
}
