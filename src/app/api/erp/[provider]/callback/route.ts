import { getMe } from "@/server/me";
import { can } from "@/server/permissions";
import { db } from "@/server/db/client";
import { isProvider, PROVIDERS, saveConnection } from "@/server/erp/connections";

// Where the accounting system sends the owner back to. Checks the state cookie, swaps the code for a long-lived link and stores it.
export async function GET(req: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  const u = await getMe();
  if (!u || !u.twoFactorEnabled || u.suspendedAt || u.role !== "seller" || !u.businessId || !can(u, "integrations.manage") || !isProvider(provider)) return new Response("not found", { status: 404 });
  const url = new URL(req.url), q = url.searchParams;
  const back = (key: "ok" | "error", msg: string) =>
    new Response(null, { status: 302, headers: { location: `${url.origin}/settings/integrations?${key}=${encodeURIComponent(msg)}`, "set-cookie": "erp_oauth=; Path=/api/erp; Max-Age=0", "cache-control": "no-store" } });
  const cookie = /(?:^|;\s*)erp_oauth=([^;]+)/.exec(req.headers.get("cookie") ?? "")?.[1];
  if (q.get("error")) return back("error", `${PROVIDERS[provider]} was not connected: ${q.get("error_description") ?? q.get("error")}`);
  if (!cookie || cookie !== `${provider}.${q.get("state")}` || !q.get("code")) return back("error", "That connection attempt could not be checked. Start again from Integrations.");
  try {
    await saveConnection(db, { businessId: u.businessId, userId: u.id, provider, code: q.get("code")!, callback: Object.fromEntries(q) });
    return back("ok", `${PROVIDERS[provider]} is connected. You can now import its unpaid invoices.`);
  } catch (e) {
    return back("error", e instanceof Error ? e.message : "Could not connect");
  }
}
