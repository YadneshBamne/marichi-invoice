import { afterEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { businessBankAccounts, businesses } from "./db/schema";
import { testDb } from "./testdb";
import { decrypt, encrypt, isEncrypted, maskTail } from "./crypto";

const K1 = Buffer.alloc(32, 1).toString("base64");
const K2 = Buffer.alloc(32, 2).toString("base64");
afterEach(() => vi.unstubAllEnvs());

describe("field encryption", () => {
  it("round-trips, never repeats ciphertext, and never double-encrypts", () => {
    vi.stubEnv("DATA_ENCRYPTION_KEY", K1);
    const a = encrypt("ABCDE1234F"), b = encrypt("ABCDE1234F");
    expect(a).not.toBe(b); expect(a).not.toContain("ABCDE"); expect(isEncrypted(a)).toBe(true);
    expect(decrypt(a)).toBe("ABCDE1234F"); expect(encrypt(a)).toBe(a);
  });
  it("detects tampering and the wrong key", () => {
    vi.stubEnv("DATA_ENCRYPTION_KEY", K1);
    const v = encrypt("1234567890");
    const [iv, tag, ct] = v.slice(7).split(".");
    expect(() => decrypt(`enc:v1:${iv}.${tag}.${Buffer.from("x" + Buffer.from(ct, "base64url").toString("latin1").slice(1), "latin1").toString("base64url")}`)).toThrow();
    vi.stubEnv("DATA_ENCRYPTION_KEY", K2);
    expect(() => decrypt(v)).toThrow(/wrong key/);
  });
  it("rotates: new writes use the new key, old values still read", () => {
    vi.stubEnv("DATA_ENCRYPTION_KEY", K1);
    const old = encrypt("secret-account");
    vi.stubEnv("DATA_ENCRYPTION_KEY", K2); vi.stubEnv("DATA_ENCRYPTION_KEY_OLD", K1);
    expect(decrypt(old)).toBe("secret-account");
    const fresh = encrypt("secret-account");
    vi.stubEnv("DATA_ENCRYPTION_KEY_OLD", "");
    expect(decrypt(fresh)).toBe("secret-account");
  });
  it("passes legacy plaintext through, and production refuses to run without a key", () => {
    expect(decrypt("PLAINPAN123")).toBe("PLAINPAN123");
    vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("DATA_ENCRYPTION_KEY", "");
    expect(() => encrypt("x")).toThrow(/not set/);
  });
  it("masks all but the tail", () => { expect(maskTail("123456789012")).toBe("••••••••9012"); expect(maskTail(null)).toBe("Not provided"); });
});

describe("encrypted columns in the database", () => {
  it("store ciphertext but read back as plain values", async () => {
    const db = await testDb();
    const [b] = await db.insert(businesses).values({ legalName: "Acme", entityType: "pvt_ltd", pan: "ABCDE1234F" }).returning();
    await db.insert(businessBankAccounts).values({ businessId: b.id, accountNumber: "50100123456789", ifsc: "HDFC0001234", holderName: "Acme" });
    const raw = (await db.execute(sql`select b.pan as pan, a.account_number as acct from businesses b join business_bank_accounts a on a.business_id = b.id`)).rows[0] as { pan: string; acct: string };
    expect(raw.pan.startsWith("enc:v1:")).toBe(true); expect(raw.acct.startsWith("enc:v1:")).toBe(true);
    expect(raw.pan).not.toContain("ABCDE"); expect(raw.acct).not.toContain("5010");
    expect((await db.select().from(businesses).where(eq(businesses.id, b.id)))[0].pan).toBe("ABCDE1234F");
    expect((await db.select().from(businessBankAccounts))[0].accountNumber).toBe("50100123456789");
  });
});
