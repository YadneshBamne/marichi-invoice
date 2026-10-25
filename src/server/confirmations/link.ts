// One-click invoice acceptance by emailed link, for buyers who have no account. The email carries a link; the page asks for the
// address it was sent to, emails a six-digit code to that address, and the buyer confirms, disputes or asks with the code. Nothing
// to register first. Afterwards the buyer is offered a company account, so the next invoices are easier.
import { createHash, randomBytes, randomInt } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "../db/client";
import { account, auditLog, businesses, buyerSellerRelationships, invoiceConfirmations, invoices, memberships, users } from "../db/schema";
import { gateway, type Adapters } from "../integrations/gateway";
import { appUrl, notifyBusiness, notifyStaff } from "../notify";
import { render } from "../notify/templates";
import { formatINR } from "../../lib/money";
import type { Decision } from "./service";
import { acceptanceText, CLARIFY_TEXT, DISPUTE_TEXT } from "./wording";
import { PLATFORM_TERMS_VERSION } from "../agreements/templates";

type Invoice = typeof invoices.$inferSelect;
export const LINK = { tokenDays: 21, codeMinutes: 10, maxAttempts: 5, resendSeconds: 60 };

const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const codeHash = (token: string, code: string) => sha(`${token}:${code}`);
const norm = (e: string) => e.trim().toLowerCase();

/** The link token for an invoice's confirmation, created on first use and stable afterwards so reminders reuse it. */
export async function tokenFor(db: Database, invoiceId: string, now = new Date()) {
  const [c] = await db.select().from(invoiceConfirmations).where(eq(invoiceConfirmations.invoiceId, invoiceId));
  if (!c) throw new Error("no confirmation request for this invoice");
  if (c.token) return c.token;
  const token = randomBytes(24).toString("base64url");
  const [done] = await db.update(invoiceConfirmations).set({ token, tokenHash: sha(token), tokenExpiresAt: new Date(now.getTime() + LINK.tokenDays * 86_400_000) })
    .where(and(eq(invoiceConfirmations.id, c.id), isNull(invoiceConfirmations.tokenHash))).returning({ token: invoiceConfirmations.token });
  if (done?.token) return done.token;
  return (await db.select().from(invoiceConfirmations).where(eq(invoiceConfirmations.id, c.id)))[0].token!; // a concurrent caller won
}

/** Everyone who can answer for the buyer on this invoice: the contact the supplier named, and the buyer's own users. */
export async function buyerAddresses(db: Database, inv: Pick<Invoice, "buyerId" | "sellerId">) {
  const [rel] = await db.select({ e: buyerSellerRelationships.contactEmail }).from(buyerSellerRelationships)
    .where(and(eq(buyerSellerRelationships.buyerId, inv.buyerId), eq(buyerSellerRelationships.sellerId, inv.sellerId)));
  const members = await db.select({ e: users.email }).from(memberships).innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.businessId, inv.buyerId), isNull(memberships.suspendedAt), isNull(users.suspendedAt)));
  const legacy = await db.select({ e: users.email }).from(users).where(and(eq(users.businessId, inv.buyerId), isNull(users.suspendedAt)));
  return { contact: rel?.e ? norm(rel.e) : null, users: [...new Set([...members, ...legacy].map((m) => norm(m.e)))] };
}

/**
 * Tell the buyer's side about an invoice, with the link. People with accounts get it in their inbox as before; the contact the
 * supplier named gets the same email directly. Nobody reachable at all goes to staff, so an invoice cannot silently wait forever.
 */
export async function sendToBuyerSide(db: Database, inv: Invoice, template: "confirmation_requested" | "confirmation_reminder", gw: Adapters = gateway, now = new Date()) {
  const path = `/confirm/${await tokenFor(db, inv.id, now)}`;
  const data = { invoiceNumber: inv.invoiceNumber, amount: formatINR(inv.amount), link: path };
  const reached = await notifyBusiness(db, inv.buyerId, template, data, gw, now);
  const { contact, users: us } = await buyerAddresses(db, inv);
  let direct = 0;
  if (contact && !us.includes(contact)) {
    const r = render(template, "email", { ...data, link: appUrl() + path });
    try {
      await gw.notify.send({ channel: "email", to: contact, template, data: { ...data, link: appUrl() + path }, subject: r && "subject" in r ? r.subject : undefined, body: r?.body ?? appUrl() + path });
      direct = 1;
    } catch { /* the reminder ladder tries again */ }
  }
  if (reached + direct === 0) await notifyStaff(db, ["ops", "admin"], "confirmation_undeliverable", { invoiceNumber: inv.invoiceNumber }, gw, now);
}

export type LinkView =
  | { state: "unknown" }
  | { state: "expired" | "answered" | "closed"; invoiceNumber: string; outcome?: string }
  | { state: "open"; invoice: { number: string; amount: string; dueDate: string; invoiceDate: string; seller: string; buyer: string }; wording: string[]; dispute: string; clarify: string };

async function load(db: Database, token: string) {
  const [row] = await db.select({ c: invoiceConfirmations, i: invoices }).from(invoiceConfirmations).innerJoin(invoices, eq(invoices.id, invoiceConfirmations.invoiceId)).where(eq(invoiceConfirmations.tokenHash, sha(token)));
  return row;
}

export async function viewByToken(db: Database, token: string, now = new Date()): Promise<LinkView> {
  const row = await load(db, token);
  if (!row) return { state: "unknown" };
  const { c, i } = row;
  if (c.status === "confirmed" || c.status === "disputed") return { state: "answered", invoiceNumber: i.invoiceNumber, outcome: c.status };
  if (i.status !== "sent_for_confirmation") return { state: "closed", invoiceNumber: i.invoiceNumber };
  if (c.tokenExpiresAt && c.tokenExpiresAt <= now) return { state: "expired", invoiceNumber: i.invoiceNumber };
  const [b] = await db.select({ buyer: businesses.legalName, displayBuyer: businesses.displayName }).from(businesses).where(eq(businesses.id, i.buyerId));
  const [s] = await db.select({ seller: businesses.legalName, display: businesses.displayName }).from(businesses).where(eq(businesses.id, i.sellerId));
  const buyer = b.displayBuyer ?? b.buyer, seller = s.display ?? s.seller;
  const w = { buyer, seller, invoiceNumber: i.invoiceNumber, amount: formatINR(i.amount), dueDate: i.dueDate };
  return { state: "open", invoice: { number: i.invoiceNumber, amount: w.amount, dueDate: i.dueDate, invoiceDate: i.invoiceDate, seller, buyer }, wording: acceptanceText(w), dispute: DISPUTE_TEXT, clarify: CLARIFY_TEXT };
}

/** Email a one-time code to an address on file. The answer is the same whether or not the address matched, so the page reveals nothing. */
export async function requestCode(db: Database, token: string, emailIn: string, gw: Adapters = gateway, now = new Date()) {
  const row = await load(db, token);
  if (!row || row.i.status !== "sent_for_confirmation" || (row.c.tokenExpiresAt && row.c.tokenExpiresAt <= now)) throw new Error("this link is no longer open");
  const email = norm(emailIn);
  if (row.c.otpSentAt && now.getTime() - row.c.otpSentAt.getTime() < LINK.resendSeconds * 1000) throw new Error(`wait a minute before asking for another code`);
  const { contact, users: us } = await buyerAddresses(db, row.i);
  if (![contact, ...us].includes(email)) return { sent: true as const }; // quietly do nothing
  const code = String(randomInt(100_000, 1_000_000));
  await db.update(invoiceConfirmations).set({
    otpHash: codeHash(token, code), otpEmail: email, otpSentAt: now, otpExpiresAt: new Date(now.getTime() + LINK.codeMinutes * 60_000), otpAttempts: 0,
  }).where(eq(invoiceConfirmations.id, row.c.id));
  const r = render("confirmation_code", "email", { code, minutes: String(LINK.codeMinutes), invoiceNumber: row.i.invoiceNumber });
  try {
    await gw.notify.send({ channel: "email", to: email, template: "confirmation_code", data: { code }, subject: r && "subject" in r ? r.subject : undefined, body: r?.body ?? code });
  } catch { throw new Error("we could not send the code. Try again in a moment"); }
  return { sent: true as const };
}

/** Check the code and, if it is right, record the buyer's answer. The code is spent by use, by expiry, or by too many wrong tries. */
export async function decideByLink(
  db: Database, token: string, p: { email: string; code: string; decision: Decision; note?: string; ip?: string; userAgent?: string }, gw: Adapters = gateway, now = new Date(),
) {
  const { applyResponse } = await import("./service"); // avoids a circular import at load time
  const row = await load(db, token);
  if (!row) throw new Error("this link is not valid");
  const { c, i } = row;
  const email = norm(p.email);
  if (!c.otpHash || !c.otpEmail || c.otpEmail !== email || !c.otpExpiresAt || c.otpExpiresAt <= now) throw new Error("ask for a new code");
  if (c.otpAttempts >= LINK.maxAttempts) throw new Error("too many wrong codes. Ask for a new one");
  if (c.otpHash !== codeHash(token, p.code.replace(/\s/g, ""))) {
    await db.update(invoiceConfirmations).set({ otpAttempts: c.otpAttempts + 1 }).where(eq(invoiceConfirmations.id, c.id));
    throw new Error("that code is not right");
  }
  await db.update(invoiceConfirmations).set({ otpHash: null, otpExpiresAt: null }).where(eq(invoiceConfirmations.id, c.id)); // spent
  if (c.tokenExpiresAt && c.tokenExpiresAt <= now) throw new Error("this link has expired");
  const r = await applyResponse(db, {
    invoiceId: i.id, decision: p.decision, note: p.note,
    who: { userId: null, email, ip: p.ip, userAgent: p.userAgent, method: "link" },
    authorise: (inv) => { if (inv.id !== c.invoiceId) throw new Error("FORBIDDEN"); },
  }, gw, now);
  return r;
}

/**
 * After confirming from the link, the buyer may create the company's account (valid for an hour, only for the verified address and
 * only while nobody has claimed the company). They become its owner and then follow the normal sign-in and setup.
 */
export async function claimAccount(
  db: Database, hash: (p: string) => Promise<string>, token: string, p: { name: string; password: string }, now = new Date(),
) {
  const row = await load(db, token);
  if (!row || !row.c.claimUntil || row.c.claimUntil <= now || !row.c.verifiedEmail) throw new Error("this offer to create an account has ended");
  if (p.name.trim().length < 2) throw new Error("enter your name");
  if (p.password.length < 10) throw new Error("the password must be at least 10 characters");
  const email = row.c.verifiedEmail;
  const [taken] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (taken) throw new Error("you already have an account. Sign in to see this invoice");
  const passwordHash = await hash(p.password);
  return db.transaction(async (tx) => {
    const [owner] = await tx.select({ id: memberships.id }).from(memberships).where(eq(memberships.businessId, row.i.buyerId)).limit(1);
    if (owner) throw new Error("this company already has an account. Ask its owner to invite you");
    const [u] = await tx.insert(users).values({ name: p.name.trim(), email, emailVerified: true, role: "buyer", businessId: row.i.buyerId, orgRole: "owner", termsVersion: PLATFORM_TERMS_VERSION, termsAcceptedAt: now }).returning();
    await tx.insert(account).values({ accountId: u.id, providerId: "credential", userId: u.id, password: passwordHash });
    await tx.insert(memberships).values({ userId: u.id, businessId: row.i.buyerId, orgRole: "owner" });
    await tx.update(businesses).set({ kind: "buyer" }).where(eq(businesses.id, row.i.buyerId));
    await tx.update(invoiceConfirmations).set({ claimUntil: null }).where(eq(invoiceConfirmations.id, row.c.id));
    await tx.insert(auditLog).values({ actorId: u.id, action: "buyer.claimed", entity: "business", entityId: row.i.buyerId, after: { email, via: "confirmation link" } });
    return { email, userId: u.id };
  });
}
