"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/server/db/client";
import { requireUser } from "@/server/rbac";
import { uploadBusinessDocument } from "@/server/kyb/documents";

/** One verification document. Problems come back on the page rather than as an error screen. */
export async function uploadDocument(fd: FormData) {
  const u = await requireUser(["seller", "buyer", "financier"]);
  let problem = "";
  try {
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) throw new Error("Choose a file first.");
    await uploadBusinessDocument(db, { id: u.id, role: u.role, orgRole: u.orgRole, businessId: u.businessId }, {
      kind: String(fd.get("kind")), bytes: Buffer.from(await file.arrayBuffer()), mime: file.type, filename: file.name, validUntil: String(fd.get("validUntil") ?? "") || null,
    });
  } catch (e) { problem = e instanceof Error ? e.message : "The document could not be saved."; }
  revalidatePath("/onboarding");
  if (problem) redirect(`/onboarding?docError=${encodeURIComponent(problem)}`);
}
