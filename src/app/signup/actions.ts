"use server";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { auth } from "@/server/auth";
import { db } from "@/server/db/client";
import { businesses, users } from "@/server/db/schema";

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
  const parsed = Form.safeParse(Object.fromEntries(fd));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const f = parsed.data;
  try {
    const { user } = await auth.api.signUpEmail({ body: { name: f.name, email: f.email, password: f.password } });
    const [biz] = await db.insert(businesses).values({ legalName: f.legalName, entityType: f.entityType }).returning();
    await db.update(users).set({ role: f.role, businessId: biz.id }).where(eq(users.id, user.id));
  } catch (e) {
    const m = e instanceof Error ? e.message : "";
    return { error: /exist|already/i.test(m) ? "An account with this email already exists. Try logging in instead." : "We couldn't create your account. Please try again." };
  }
  redirect("/mfa");
}
