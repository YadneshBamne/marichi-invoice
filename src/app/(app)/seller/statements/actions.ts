"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/server/db/client";
import { requireUser } from "@/server/rbac";
import { uploadStatement } from "@/server/statements/service";

/** One bank statement. Problems come back to the page with the message instead of an error screen. */
export async function upload(fd: FormData) {
  const u = await requireUser(["seller"]);
  let to = "/seller/statements";
  try {
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) throw new Error("Choose the statement file first.");
    const row = await uploadStatement(db, { id: u.id, role: u.role, orgRole: u.orgRole, businessId: u.businessId }, { bytes: Buffer.from(await file.arrayBuffer()), mime: file.type, fileName: file.name });
    to += row.status === "parsed" ? "?ok=" + encodeURIComponent("Statement read. The figures are below.") : "?error=" + encodeURIComponent(row.failure ?? "The statement could not be read.");
  } catch (e) { to += "?error=" + encodeURIComponent(e instanceof Error ? e.message : "Something went wrong"); }
  revalidatePath("/seller/statements");
  redirect(to);
}
