// API keys for outside systems (an ERP, an accounting tool, a script). The key is shown once; only its hash is stored.
import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Database } from "../db/client";
import { apiKeys, auditLog } from "../db/schema";
import { assertCan } from "../permissions";

export type KeyActor = { id: string; role: string; orgRole: string; businessId: string | null };
const PREFIX = "mk_live_";
const hash = (key: string) => createHash("sha256").update(key).digest("hex");

export async function createApiKey(db: Database, actor: KeyActor, name: string) {
  assertCan(actor, "integrations.manage");
  if (!actor.businessId || !["seller", "buyer"].includes(actor.role)) throw new Error("only a seller or buyer company can have API keys");
  const label = name.trim();
  if (label.length < 2 || label.length > 60) throw new Error("give the key a name (2 to 60 characters)");
  const key = PREFIX + randomBytes(24).toString("base64url");
  const [row] = await db.insert(apiKeys).values({ businessId: actor.businessId, kind: actor.role, name: label, prefix: key.slice(0, PREFIX.length + 6), keyHash: hash(key), createdBy: actor.id }).returning();
  await db.insert(auditLog).values({ actorId: actor.id, action: "apikey.created", entity: "business", entityId: actor.businessId, after: { keyId: row.id, name: label } });
  return { id: row.id, key }; // the only time the key exists in the clear
}

export async function revokeApiKey(db: Database, actor: KeyActor, keyId: string, now = new Date()) {
  assertCan(actor, "integrations.manage");
  const [r] = await db.update(apiKeys).set({ revokedAt: now }).where(and(eq(apiKeys.id, keyId), eq(apiKeys.businessId, actor.businessId ?? ""), isNull(apiKeys.revokedAt))).returning();
  if (!r) throw new Error("key not found or already revoked");
  await db.insert(auditLog).values({ actorId: actor.id, action: "apikey.revoked", entity: "business", entityId: r.businessId, after: { keyId } });
}

export const listApiKeys = (db: Database, businessId: string) =>
  db.select({ id: apiKeys.id, name: apiKeys.name, prefix: apiKeys.prefix, kind: apiKeys.kind, createdAt: apiKeys.createdAt, lastUsedAt: apiKeys.lastUsedAt, revokedAt: apiKeys.revokedAt })
    .from(apiKeys).where(eq(apiKeys.businessId, businessId)).orderBy(desc(apiKeys.createdAt));

/** Resolve a presented key to its company, or null. Records last use (at most once a minute, to keep writes cheap). */
export async function authenticateKey(db: Database, presented: string | null | undefined, now = new Date()) {
  if (!presented || !presented.startsWith(PREFIX) || presented.length > 200) return null;
  const [k] = await db.select().from(apiKeys).where(and(eq(apiKeys.keyHash, hash(presented)), isNull(apiKeys.revokedAt)));
  if (!k) return null;
  if (!k.lastUsedAt || now.getTime() - k.lastUsedAt.getTime() > 60_000) await db.update(apiKeys).set({ lastUsedAt: now }).where(eq(apiKeys.id, k.id));
  return { businessId: k.businessId, kind: k.kind as "seller" | "buyer", keyId: k.id };
}

export const bearer = (req: Request) => {
  const h = req.headers.get("authorization") ?? "";
  return /^Bearer\s+/i.test(h) ? h.replace(/^Bearer\s+/i, "").trim() : null;
};
