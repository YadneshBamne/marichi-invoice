"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { auth } from "@/server/auth";
import { db } from "@/server/db/client";
import { requireUser } from "@/server/rbac";
import { acceptOwnership, cancelOwnershipOffer, offerOwnership, requestMemberReset, setDualControl, setMemberRole, setSuspended } from "@/server/company/service";
import { cancelInvitation, inviteMember, resendInvitation } from "@/server/company/invitations";
import { ORG_ROLES } from "@/server/permissions";

type R<T = object> = ({ ok: true } & T) | { ok: false; error: string };

async function guarded<T extends object>(fn: (a: { id: string; role: string; orgRole: string; businessId: string | null }) => Promise<T>): Promise<R<T>> {
  const u = await requireUser(["seller", "buyer", "financier"]);
  try {
    const out = await fn({ id: u.id, role: u.role, orgRole: u.orgRole, businessId: u.businessId });
    revalidatePath("/settings/team");
    return { ok: true, ...out };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Something went wrong." };
  }
}
const Id = z.uuid();
const Role = z.enum(ORG_ROLES).exclude(["owner"]);

export async function invite(p: { email: string; orgRole: string }) {
  return guarded(async (a) => {
    const f = z.object({ email: z.email("Enter a valid email address."), orgRole: Role }).parse(p);
    const r = await inviteMember(db, a, f);
    return { emailed: r.emailed };
  });
}
export async function resend(id: string) {
  return guarded(async (a) => ({ emailed: (await resendInvitation(db, a, Id.parse(id))).emailed }));
}
export async function cancelInvite(id: string) {
  return guarded(async (a) => { await cancelInvitation(db, a, Id.parse(id)); return {}; });
}
export async function changeRole(userId: string, orgRole: string) {
  return guarded(async (a) => { await setMemberRole(db, a, Id.parse(userId), Role.parse(orgRole)); return {}; });
}
export async function suspend(userId: string, suspended: boolean) {
  return guarded(async (a) => { await setSuspended(db, a, Id.parse(userId), suspended); return {}; });
}
/** Nobody types anyone else's password. A person who is locked out gets a reset link to their own email. */
export async function sendResetLink(userId: string) {
  return guarded(async (a) => {
    await requestMemberReset(db, a, Id.parse(userId), async (email) => { await auth.api.requestPasswordReset({ body: { email, redirectTo: "/reset-password" } }); });
    return {};
  });
}
export async function offerOwner(userId: string) {
  return guarded(async (a) => { await offerOwnership(db, a, Id.parse(userId)); return {}; });
}
export async function cancelOwnerOffer() {
  return guarded(async (a) => { await cancelOwnershipOffer(db, a); return {}; });
}
export async function acceptOwner() {
  return guarded(async (a) => { await acceptOwnership(db, a); revalidatePath("/", "layout"); return {}; });
}
export async function setDual(on: boolean) {
  return guarded(async (a) => { await setDualControl(db, a, on); return {}; });
}
