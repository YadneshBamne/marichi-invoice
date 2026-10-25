import { createDecipheriv, createECDH, createPublicKey, hkdfSync, verify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { encryptPayload, generateVapidKeys, vapidAuthorization, webpushNotify, type PushKeys } from "./webpush";
import { mock } from "./mock";

const b = (s: string) => Buffer.from(s, "base64url");
const vapid = generateVapidKeys();
const ua = createECDH("prime256v1");
ua.generateKeys();
const keys: PushKeys = { p256dh: ua.getPublicKey().toString("base64url"), auth: "BTBZMqHH6r4Tts7J_aSIgg" };
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc";
const msg = { channel: "push" as const, to: ENDPOINT, template: "disbursed", data: {}, subject: "Payout sent", body: JSON.stringify({ body: "₹1,000.00 paid", url: "/notifications" }) };

/** What a browser does: undo the RFC 8291 encryption with its own private key. */
function decrypt(body: Buffer) {
  const salt = body.subarray(0, 16), asPublic = body.subarray(21, 86), record = body.subarray(86);
  const ikm = Buffer.from(hkdfSync("sha256", ua.computeSecret(asPublic), b(keys.auth), Buffer.concat([Buffer.from("WebPush: info\0"), ua.getPublicKey(), asPublic]), 32));
  const d = createDecipheriv("aes-128-gcm", Buffer.from(hkdfSync("sha256", ikm, salt, "Content-Encoding: aes128gcm\0", 16)), Buffer.from(hkdfSync("sha256", ikm, salt, "Content-Encoding: nonce\0", 12)));
  d.setAuthTag(record.subarray(-16));
  const plain = Buffer.concat([d.update(record.subarray(0, -16)), d.final()]);
  expect(plain.at(-1)).toBe(2); // last-record delimiter
  return plain.subarray(0, -1).toString();
}

const call = (f: ReturnType<typeof vi.fn>) => f.mock.calls[0] as unknown as [string, RequestInit];

function adapter(status = 201, over: Partial<Parameters<typeof webpushNotify>[1]> = {}) {
  const f = vi.fn(async () => new Response("", { status }));
  const remove = vi.fn();
  const a = webpushNotify(mock.notify, { ...vapid, subject: "mailto:ops@example.com", lookup: () => keys, remove, fetch: f as unknown as typeof fetch, ...over });
  return { a, f, remove };
}

describe("Web Push encryption (RFC 8291)", () => {
  it("reproduces the RFC's Appendix A example byte for byte", () => {
    const body = encryptPayload(b("V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24"),
      { p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" },
      { salt: b("DGv6ra1nlYgDCS1FRnbzlw"), asPrivate: b("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw") });
    const header = b("DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8");
    const cipher = b("8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ");
    expect(body.equals(Buffer.concat([header, cipher]))).toBe(true);
  });
  it("round-trips for a fresh key pair, and refuses bad keys or oversized messages", () => {
    expect(decrypt(encryptPayload(Buffer.from("hello"), keys))).toBe("hello");
    expect(() => encryptPayload(Buffer.from("x"), { ...keys, auth: "AAAA" })).toThrow(/malformed/);
    expect(() => encryptPayload(Buffer.from("x"), { ...keys, p256dh: "AAAA" })).toThrow(/malformed/);
    expect(() => encryptPayload(Buffer.alloc(4000), keys)).toThrow(/too large/);
  });
});

describe("VAPID (RFC 8292)", () => {
  it("makes 65-byte public and 32-byte private keys", () => {
    expect(b(vapid.publicKey)).toHaveLength(65);
    expect(b(vapid.privateKey)).toHaveLength(32);
  });
  it("signs a JWT for the push service origin that the public key verifies", () => {
    const h = vapidAuthorization("https://fcm.googleapis.com/fcm/send/abc", { ...vapid, subject: "mailto:ops@example.com" }, 1_000_000);
    const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(h)!;
    expect(m[4]).toBe(vapid.publicKey);
    expect(JSON.parse(b(m[1]).toString())).toEqual({ typ: "JWT", alg: "ES256" });
    expect(JSON.parse(b(m[2]).toString())).toEqual({ aud: "https://fcm.googleapis.com", exp: 1_000_000 + 43_200, sub: "mailto:ops@example.com" });
    const pub = b(vapid.publicKey);
    const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33).toString("base64url") }, format: "jwk" });
    expect(verify("sha256", Buffer.from(`${m[1]}.${m[2]}`), { key, dsaEncoding: "ieee-p1363" }, b(m[3]))).toBe(true);
  });
});

describe("Web Push adapter", () => {
  it("posts the encrypted message to the endpoint with VAPID, TTL and urgency headers", async () => {
    const { a, f } = adapter();
    expect(await a.send(msg)).toEqual({});
    const [url, init] = call(f);
    const h = init.headers as Record<string, string>;
    expect(url).toBe(ENDPOINT);
    expect(init.method).toBe("POST");
    expect(h.authorization).toMatch(/^vapid t=.+, k=/);
    expect(h).toMatchObject({ "content-encoding": "aes128gcm", "content-type": "application/octet-stream", ttl: "86400", urgency: "high" }); // disbursed is critical
    expect(JSON.parse(decrypt(Buffer.from(init.body as Uint8Array)))).toEqual({ title: "Payout sent", body: "₹1,000.00 paid", url: "/notifications" });
  });
  it("uses normal urgency for non-critical templates", async () => {
    const { a, f } = adapter();
    await a.send({ ...msg, template: "offer_ready" });
    expect((call(f)[1].headers as Record<string, string>).urgency).toBe("normal");
  });
  it("404 and 410 delete the subscription and fail for good", async () => {
    for (const status of [404, 410]) {
      const { a, remove } = adapter(status);
      await expect(a.send(msg)).rejects.toMatchObject({ permanent: true, message: expect.stringContaining(String(status)) });
      expect(remove).toHaveBeenCalledWith(ENDPOINT);
    }
  });
  it("an unknown subscription fails for good without calling out", async () => {
    const { a, f, remove } = adapter(201, { lookup: () => null });
    await expect(a.send(msg)).rejects.toMatchObject({ permanent: true });
    expect(f).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
  it("400/413 are final, 401/403/429/5xx are retried and keep the subscription", async () => {
    for (const status of [400, 413]) await expect(adapter(status).a.send(msg)).rejects.toMatchObject({ permanent: true });
    for (const status of [401, 403, 429, 503]) {
      const { a, remove } = adapter(status);
      const e = await a.send(msg).catch((x) => x);
      expect(e.message).toContain(String(status));
      expect(e.permanent).toBeUndefined();
      expect(remove).not.toHaveBeenCalled();
    }
  });
  it("network errors propagate; plain-text bodies still work; other channels go to the fallback", async () => {
    await expect(adapter(201, { fetch: vi.fn(async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch }).a.send(msg)).rejects.toThrow(/ECONNRESET/);
    const { a, f } = adapter();
    await a.send({ ...msg, body: "plain" });
    expect(JSON.parse(decrypt(Buffer.from(call(f)[1].body as Uint8Array)))).toMatchObject({ body: "plain" });
    const g = adapter();
    expect((await g.a.send({ channel: "email", to: "a@b.com", template: "t", data: {}, body: "B" }))?.providerRef).toMatch(/^MOCKMSG-/);
    expect(g.f).not.toHaveBeenCalled();
  });
});
