"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { db } from "@/server/db/client";
import { requireApp, requireUser } from "@/server/rbac";
import { assertCan } from "@/server/permissions";
import { disconnect, isProvider, syncConnection } from "@/server/erp/connections";
import { scanInvoice } from "@/server/fraud/engine";
import { sendForConfirmation } from "@/server/confirmations/service";

const PATH = "/settings/integrations";
const go = (key: "ok" | "error", msg: string): never => redirect(`${PATH}?${key}=${encodeURIComponent(msg)}`);

async function seller(permission: "integrations.manage" | "invoice.upload") {
  const u = await requireUser(["seller"]);
  requireApp(u, "integrations");
  assertCan(u, permission);
  return u;
}

/** Check (dry run) or import the unpaid invoices from a connected accounting system. */
export async function syncErp(fd: FormData) {
  const u = await seller("invoice.upload");
  const provider = String(fd.get("provider"));
  const dryRun = fd.get("mode") !== "import";
  let msg: string, ok = true;
  try {
    if (!isProvider(provider)) throw new Error("unknown accounting system");
    const r = await syncConnection(db, u.businessId!, provider, { dryRun });
    const bad = r.results.filter((x) => !x.ok).slice(0, 3).map((x) => `${x.number}: ${x.error}`);
    msg = `${dryRun ? "Check" : "Import"}: ${r.found} unpaid invoice${r.found === 1 ? "" : "s"} found, ${r.skipped} already on the platform, ${dryRun ? r.valid + " ready to import" : r.imported + " imported"}, ${r.invalid} cannot be imported.${bad.length ? ` For example ${bad.join("; ")}.` : ""}`;
    if (!dryRun) {
      const ids = r.results.flatMap((x) => (x.id ? [x.id] : []));
      after(async () => {
        for (const id of ids) {
          await scanInvoice(db, id).catch((e) => console.error("[fraud-scan]", e.message));
          await sendForConfirmation(db, id).catch(() => undefined);
        }
      });
      revalidatePath("/seller/invoices");
    }
  } catch (e) { msg = e instanceof Error ? e.message : "Something went wrong"; ok = false; }
  revalidatePath(PATH);
  return go(ok ? "ok" : "error", msg);
}

export async function disconnectErp(fd: FormData) {
  const u = await seller("integrations.manage");
  const provider = String(fd.get("provider"));
  if (!isProvider(provider)) return go("error", "unknown accounting system");
  await disconnect(db, { businessId: u.businessId!, userId: u.id, provider });
  revalidatePath(PATH);
  return go("ok", "Disconnected.");
}
