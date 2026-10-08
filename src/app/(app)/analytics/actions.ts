"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/server/db/client";
import { requireUser } from "@/server/rbac";
import { subscribe, unsubscribe } from "@/server/analytics/service";

const Form = z.object({ kind: z.string(), frequency: z.string().optional(), path: z.enum(["/analytics", "/admin/analytics"]) });

export async function schedule(fd: FormData) {
  const u = await requireUser();
  const f = Form.parse(Object.fromEntries(fd));
  if (fd.get("action") === "stop") await unsubscribe(db, u.id, f.kind);
  else await subscribe(db, { id: u.id, role: u.role, businessId: u.businessId }, f.kind, f.frequency ?? "weekly");
  revalidatePath(f.path);
}
