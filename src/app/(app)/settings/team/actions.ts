"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/server/db/client";
import { requireUser } from "@/server/rbac";
import { addMember, resetMemberPassword, setMemberRole, setSuspended } from "@/server/company/service";
import { hashPassword } from "@/server/company/credentials";

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

export async function add(p: { name: string; email: string; orgRole: "manager" | "member" }) {
  return guarded(async (a) => {
    const f = z.object({ name: z.string(), email: z.email("Enter a valid email address."), orgRole: z.enum(["manager", "member"]) }).parse(p);
    const { password } = await addMember(db, hashPassword, a, f);
    return { email: f.email.toLowerCase(), password };
  });
}
export async function resetPassword(userId: string) {
  return guarded((a) => resetMemberPassword(db, hashPassword, a, Id.parse(userId)));
}
export async function changeRole(userId: string, orgRole: "manager" | "member") {
  return guarded(async (a) => { await setMemberRole(db, a, Id.parse(userId), z.enum(["manager", "member"]).parse(orgRole)); return {}; });
}
export async function suspend(userId: string, suspended: boolean) {
  return guarded(async (a) => { await setSuspended(db, a, Id.parse(userId), suspended); return {}; });
}
