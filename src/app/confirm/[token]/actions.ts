"use server";
import { after } from "next/server";
import { headers } from "next/headers";
import { z } from "zod";
import { db } from "@/server/db/client";
import { claimAccount, decideByLink, requestCode } from "@/server/confirmations/link";
import { hashPassword } from "@/server/company/credentials";
import { underwriteInvoice } from "@/server/underwriting/service";
import { generateOffer } from "@/server/offers/service";

export type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };
const fail = (e: unknown): { ok: false; error: string } => ({ ok: false, error: e instanceof Error ? e.message : "Something went wrong." });
const Token = z.string().min(20).max(80);

/** Step 1: email a one-time code to an address on file. The reply is the same whether or not the address matched. */
export async function sendCode(token: string, email: string): Promise<Result> {
  try { await requestCode(db, Token.parse(token), z.email("Enter a valid email address.").parse(email)); return { ok: true }; }
  catch (e) { return fail(e); }
}

/** Step 2: the code plus the buyer's answer, in one go. A confirmed invoice is underwritten and offered after the response. */
export async function decide(token: string, email: string, code: string, decision: "confirm" | "dispute" | "clarify", note: string): Promise<Result<{ status: string }>> {
  try {
    const f = z.object({ token: Token, email: z.email(), code: z.string().min(4).max(10), decision: z.enum(["confirm", "dispute", "clarify"]), note: z.string().max(1000) }).parse({ token, email, code, decision, note });
    const h = await headers();
    const r = await decideByLink(db, f.token, { email: f.email, code: f.code, decision: f.decision, note: f.note, ip: h.get("x-forwarded-for")?.split(",")[0].trim(), userAgent: h.get("user-agent") ?? undefined });
    if (r.status === "eligible") {
      after(async () => {
        try { const d = await underwriteInvoice(db, r.invoiceId); if (d.decision === "approved") await generateOffer(db, r.invoiceId); }
        catch (e) { console.error("[underwrite]", (e as Error).message); }
      });
    }
    return { ok: true, status: r.status };
  } catch (e) { return fail(e); }
}

/** Step 3 (optional): create the company's account, for the address that was just verified. The browser then signs in. */
export async function claim(token: string, name: string, password: string): Promise<Result<{ email: string }>> {
  try {
    const r = await claimAccount(db, hashPassword, Token.parse(token), { name, password });
    return { ok: true, email: r.email };
  } catch (e) { return fail(e); }
}
