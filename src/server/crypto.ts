// Application-layer encryption for sensitive fields (PAN, bank account numbers). AES-256-GCM, a fresh random IV per value.
// Stored form: enc:v1:<iv>.<tag>.<ciphertext> (base64url). Anything not starting with enc:v1: is treated as legacy plaintext
// and returned as is, so existing rows keep working until scripts/encrypt-existing.ts has converted them.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const PREFIX = "enc:v1:";
const AAD = Buffer.from("marichi:v1");

function parseKey(raw: string): Buffer {
  const k = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (k.length !== 32) throw new Error("DATA_ENCRYPTION_KEY must be 32 bytes (base64 or 64 hex characters): openssl rand -base64 32");
  return k;
}

/** Newest key first. DATA_ENCRYPTION_KEY_OLD lets you rotate: new writes use the new key, old values still decrypt. */
function keyring(): Buffer[] {
  const cur = process.env.DATA_ENCRYPTION_KEY;
  if (!cur) {
    if (process.env.NODE_ENV === "production") throw new Error("DATA_ENCRYPTION_KEY is not set");
    return [createHash("sha256").update("marichi-development-only-key").digest()]; // dev and tests only: never protects real data
  }
  return [parseKey(cur), ...(process.env.DATA_ENCRYPTION_KEY_OLD ? [parseKey(process.env.DATA_ENCRYPTION_KEY_OLD)] : [])];
}

export const isEncrypted = (v: string) => v.startsWith(PREFIX);

export function encrypt(plain: string): string {
  if (isEncrypted(plain)) return plain; // already protected: never double-encrypt
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", keyring()[0], iv);
  c.setAAD(AAD);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `${PREFIX}${iv.toString("base64url")}.${c.getAuthTag().toString("base64url")}.${ct.toString("base64url")}`;
}

export function decrypt(stored: string): string {
  if (!isEncrypted(stored)) return stored; // legacy plaintext
  const [iv, tag, ct] = stored.slice(PREFIX.length).split(".");
  if (!iv || !tag || !ct) throw new Error("malformed encrypted value");
  for (const key of keyring()) {
    try {
      const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
      d.setAAD(AAD);
      d.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
    } catch { /* wrong key or tampered: try the next key */ }
  }
  throw new Error("could not decrypt value: wrong key or tampered data");
}

/** For screens and logs: show enough to recognise, never enough to use. */
export const maskTail = (v: string | null | undefined, keep = 4) => (v ? `${"•".repeat(Math.max(v.length - keep, 0))}${v.slice(-keep)}` : "Not provided");
