import { after } from "next/server";
import { db } from "@/server/db/client";
import { scanInvoice } from "@/server/fraud/engine";
import { sendForConfirmation } from "@/server/confirmations/service";
import { ApiError } from "@/server/erp/invoices";
import { importErpRows } from "@/server/erp/connectors/import";
import { parseTallyVouchers } from "@/server/erp/connectors/tally";
import { market } from "@/lib/countries";
import { authed, fail, fromError, reply } from "../../_lib";

// POST /api/v1/erp/tally[?dryRun=1]   (sellers only) The body is the XML a customer's Tally returned for a Sales-voucher export,
// usually sent by scripts/tally-agent.mjs. Each voucher becomes an invoice exactly as a CSV row would. A dry run changes nothing.
export async function POST(req: Request) {
  const a = await authed(req);
  if ("res" in a) return a.res;
  if (a.who.kind !== "seller") return fail(403, "FORBIDDEN", "only a seller key can import invoices");
  const xml = await req.text();
  if (!xml.trim()) return fail(400, "BAD_REQUEST", "the body must be the XML from Tally");
  if (xml.length > 5_000_000) return fail(413, "TOO_LARGE", "that file is too large; export a shorter date range");
  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";
  try {
    const r = await importErpRows(db, a.who.businessId, parseTallyVouchers(xml, market().currency.code), { dryRun });
    if (!dryRun) {
      const ids = r.results.flatMap((x) => (x.id ? [x.id] : []));
      after(async () => {
        for (const id of ids) {
          await scanInvoice(db, id).catch((e) => console.error("[fraud-scan]", e.message));
          await sendForConfirmation(db, id).catch(() => undefined); // only invoices that reached "validated" are sent; the rest wait for the worker
        }
      });
    }
    return reply(r, dryRun ? 200 : 201);
  } catch (e) {
    return e instanceof ApiError ? fromError(e) : fail(422, "INVALID", (e as Error).message);
  }
}
