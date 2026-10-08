"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/server/db/client";
import { requireUser } from "@/server/rbac";
import { assertCan } from "@/server/permissions";
import { applyMandateStatus, myMandate, registerMandate, revokeMandate } from "@/server/collections/nach";
import { rupeesToPaise } from "@/lib/money";

export type AutopayState = { error?: string; values?: Record<string, string> };

export async function setupAutopay(_: AutopayState, fd: FormData): Promise<AutopayState> {
  const u = await requireUser(["buyer"]);
  const values = Object.fromEntries([...fd.entries()].filter(([, v]) => typeof v === "string")) as Record<string, string>;
  try {
    assertCan(u, "invoice.confirm"); // a mandate lets us debit the company's account, so it is a commitment
    const f = z.object({ accountNumber: z.string(), ifsc: z.string(), holderName: z.string(), maxAmount: z.string() }).parse(values);
    await registerMandate(db, { id: u.id, role: u.role, businessId: u.businessId }, { ...f, maxAmount: rupeesToPaise(f.maxAmount) });
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not set up auto-pay", values };
  }
  revalidatePath("/buyer/invoices");
  return {};
}

/** Simulated bank authorisation. Only exists in mock mode: with a real provider the bank's webhook does this. */
export async function authoriseAutopay() {
  const u = await requireUser(["buyer"]);
  assertCan(u, "invoice.confirm");
  if ((process.env.INTEGRATIONS_MODE ?? "mock") !== "mock") throw new Error("authorisation happens at your bank");
  const m = u.businessId ? await myMandate(db, u.businessId) : null;
  if (m?.providerRef && m.status === "pending") await applyMandateStatus(db, m.providerRef, "active");
  revalidatePath("/buyer/invoices");
}

export async function revokeAutopay(fd: FormData) {
  const u = await requireUser(["buyer"]);
  assertCan(u, "invoice.confirm");
  await revokeMandate(db, { id: u.id, role: u.role, businessId: u.businessId }, z.uuid().parse(fd.get("mandateId")));
  revalidatePath("/buyer/invoices");
}
