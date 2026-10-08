"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/server/db/client";
import { requireApp, requireUser } from "@/server/rbac";
import { createApiKey, revokeApiKey } from "@/server/erp/keys";
import { createEndpoint, sendTest, setEndpointActive } from "@/server/erp/events";

export type Secret = { error?: string; secret?: { label: string; value: string } };

async function owner() {
  const u = await requireUser(["seller", "buyer"]);
  requireApp(u, "integrations");
  return { id: u.id, role: u.role as string, orgRole: u.orgRole as string, businessId: u.businessId };
}

export async function newKey(_: Secret, fd: FormData): Promise<Secret> {
  const a = await owner();
  try {
    const r = await createApiKey(db, a, String(fd.get("name") ?? ""));
    revalidatePath("/settings/integrations");
    return { secret: { label: "API key", value: r.key } };
  } catch (e) { return { error: e instanceof Error ? e.message : "Could not create the key" }; }
}

export async function newEndpoint(_: Secret, fd: FormData): Promise<Secret> {
  const a = await owner();
  try {
    const r = await createEndpoint(db, a, { url: String(fd.get("url") ?? ""), events: fd.getAll("events").map(String) });
    revalidatePath("/settings/integrations");
    return { secret: { label: "Signing secret", value: r.secret } };
  } catch (e) { return { error: e instanceof Error ? e.message : "Could not add the endpoint" }; }
}

const Id = z.uuid();
export async function revokeKey(fd: FormData) { await revokeApiKey(db, await owner(), Id.parse(fd.get("id"))); revalidatePath("/settings/integrations"); }
export async function toggleEndpoint(fd: FormData) { await setEndpointActive(db, await owner(), Id.parse(fd.get("id")), fd.get("active") === "1"); revalidatePath("/settings/integrations"); }
export async function testEndpoint(fd: FormData) { await sendTest(db, await owner(), Id.parse(fd.get("id"))); revalidatePath("/settings/integrations"); }
