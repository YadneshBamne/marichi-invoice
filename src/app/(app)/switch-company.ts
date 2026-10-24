"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/server/db/client";
import { getMe } from "@/server/me";
import { switchCompany } from "@/server/company/service";

/** Work in another company this person belongs to. Returns an error message instead of throwing so the menu can show it. */
export async function switchTo(businessId: string): Promise<{ ok: boolean; error?: string }> {
  const me = await getMe();
  if (!me) return { ok: false, error: "Sign in again." };
  try {
    await switchCompany(db, me.id, z.uuid().parse(businessId));
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : "Could not switch." }; }
}
