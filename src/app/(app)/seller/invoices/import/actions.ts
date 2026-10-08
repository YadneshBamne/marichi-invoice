"use server";
import { revalidatePath } from "next/cache";
import { db } from "@/server/db/client";
import { requireUser } from "@/server/rbac";
import { assertCan } from "@/server/permissions";
import { importInvoices, type RowResult } from "@/server/erp/csv";
import { ApiError } from "@/server/erp/invoices";

export type ImportOutcome = { ok: true; results: RowResult[]; valid: number; invalid: number; imported: number; dryRun: boolean } | { ok: false; error: string };

/** Check a CSV (dryRun) or import it. A dry run changes nothing. */
export async function runImport(text: string, dryRun: boolean): Promise<ImportOutcome> {
  const u = await requireUser(["seller"]);
  try {
    assertCan(u, "invoice.upload");
    if (text.length > 1_000_000) return { ok: false, error: "That file is too large. Import 200 invoices or fewer at a time." };
    const r = await importInvoices(db, u.businessId!, text, { dryRun });
    if (!dryRun) revalidatePath("/seller/invoices");
    return { ok: true, ...r, dryRun };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError || e instanceof Error ? e.message : "The file could not be read." };
  }
}
