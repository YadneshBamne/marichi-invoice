import { randomBytes } from "node:crypto";
import { getMe } from "@/server/me";
import { can } from "@/server/permissions";
import { accountingFor, isProvider } from "@/server/erp/connections";

// Starts the connection to an accounting system: sends the owner to the provider's own sign-in and permission screen.
// A random state value is kept in a short-lived cookie and checked when they come back, so nobody else can complete the link for them.
export async function GET(req: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  const u = await getMe();
  if (!u || !u.twoFactorEnabled || u.suspendedAt || u.role !== "seller" || !u.businessId || !can(u, "integrations.manage") || !isProvider(provider)) return new Response("not found", { status: 404 });
  const a = accountingFor(provider);
  if (!a) return new Response("this accounting system is not set up on this platform", { status: 404 });
  const state = randomBytes(24).toString("base64url");
  const secure = new URL(req.url).protocol === "https:" ? "; Secure" : "";
  return new Response(null, { status: 302, headers: { location: a.authorizeUrl(state), "set-cookie": `erp_oauth=${provider}.${state}; Path=/api/erp; Max-Age=600; HttpOnly; SameSite=Lax${secure}`, "cache-control": "no-store" } });
}
