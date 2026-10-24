"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/server/db/client";
import { getSession } from "@/server/session";
import { acceptAsExistingUser, acceptAsNewUser } from "@/server/company/invitations";
import { hashPassword } from "@/server/company/credentials";

export type Result = { ok: true; email: string } | { ok: false; error: string };
const fail = (e: unknown): Result => ({ ok: false, error: e instanceof Error ? e.message : "Something went wrong." });

/** A new person sets their own name and password. The browser then signs them in and the normal guards take them to two-step setup. */
export async function joinAsNew(token: string, name: string, password: string): Promise<Result> {
  try {
    const f = z.object({ token: z.string().min(20), name: z.string(), password: z.string() }).parse({ token, name, password });
    const r = await acceptAsNewUser(db, hashPassword, f.token, { name: f.name, password: f.password });
    return { ok: true, email: r.email };
  } catch (e) { return fail(e); }
}

/** Someone already signed in as the invited address adds this company to their account. */
export async function joinAsExisting(token: string): Promise<Result> {
  try {
    const s = await getSession();
    if (!s) throw new Error("Sign in first.");
    await acceptAsExistingUser(db, s.user.id, z.string().min(20).parse(token));
    revalidatePath("/", "layout");
    return { ok: true, email: s.user.email };
  } catch (e) { return fail(e); }
}
