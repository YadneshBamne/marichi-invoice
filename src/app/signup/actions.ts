"use server";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { auth } from "@/server/auth";
import { db } from "@/server/db/client";
import { businesses, memberships, users } from "@/server/db/schema";
import { PLATFORM_TERMS_VERSION } from "@/server/agreements/templates";
import { flagOn, refreshFlags } from "@/server/flags/service";

const Form = z.object({
  name: z.string().trim().min(2, "Enter your full name."),
  email: z.email("Enter a valid email address."),
  password: z.string().min(10, "Use at least 10 characters for the password."),
  // Self-service roles only. Staff roles are created by scripts/seed-staff.ts.
  role: z.enum(["seller", "buyer", "financier"]),
  legalName: z.string().trim().min(2, "Enter the business legal name."),
  entityType: z.string().min(2, "Choose the entity type."),
  terms: z.literal("on", "Accept the terms to continue."),
});

export type SignUpState = { error?: string };

export async function signUp(_: SignUpState, fd: FormData): Promise<SignUpState> {
  await refreshFlags(db);
  if (!flagOn("signup")) return { error: "New accounts are paused for the moment. Please try again later." };
  const parsed = Form.safeParse(Object.fromEntries(fd));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const f = parsed.data;
  try {
    const { user } = await auth.api.signUpEmail({ body: { name: f.name, email: f.email, password: f.password } });
    const [biz] = await db.insert(businesses).values({ legalName: f.legalName, entityType: f.entityType, kind: f.role }).returning();
    await db.update(users).set({ role: f.role, businessId: biz.id, orgRole: "owner", termsVersion: PLATFORM_TERMS_VERSION, termsAcceptedAt: new Date() }).where(eq(users.id, user.id));
    await db.insert(memberships).values({ userId: user.id, businessId: biz.id, orgRole: "owner" });
  } catch (e) {
    const m = e instanceof Error ? e.message : "";
    return { error: /exist|already/i.test(m) ? "An account with this email already exists. Try logging in instead." : "We couldn't create your account. Please try again." };
  }
  redirect("/mfa");
}
