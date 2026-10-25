// Browser Web Push (free, no provider account): the message is encrypted for one browser and posted to the push service URL the
// browser gave us. Needs a VAPID key pair (`node scripts/vapid-keys.mjs`): NEXT_PUBLIC_VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT.
// Written with node:crypto, no dependency. Other channels go to the fallback port.
// Docs used:
//  - Protocol (POST, TTL and Urgency headers, 201 Created, 404/410 = subscription gone): https://www.rfc-editor.org/rfc/rfc8030
//  - Encryption (aes128gcm, HKDF "WebPush: info", Appendix A test vector, used in webpush.test.ts): https://www.rfc-editor.org/rfc/rfc8291
//  - VAPID (ES256 JWT with aud/exp/sub, `Authorization: vapid t=..., k=...`): https://www.rfc-editor.org/rfc/rfc8292
import { createECDH, createCipheriv, createPrivateKey, hkdfSync, randomBytes, sign } from "node:crypto";
import type { NotifyPort } from "./gateway";
import { TEMPLATES } from "../notify/templates";

export type PushKeys = { p256dh: string; auth: string };
export type PushConfig = {
  publicKey: string; privateKey: string; subject: string; // base64url key pair, and a mailto:/https: contact for the push service
  lookup: (endpoint: string) => PushKeys | null | Promise<PushKeys | null>;
  remove: (endpoint: string) => void | Promise<void>;
  fetch?: typeof fetch;
};

const b64 = (b: Buffer) => b.toString("base64url");
const TTL_SECONDS = 86_400; // how long the push service keeps the message if the browser is offline
const MAX_PLAINTEXT = 3993; // RFC 8291: the largest message every push service must accept (4096 - header)

/** A retry cannot help: the outbox marks the row failed straight away. */
const permanent = (message: string) => Object.assign(new Error(message), { permanent: true });

/** A new VAPID key pair as base64url strings (public: 65-byte uncompressed point, private: 32 bytes). */
export function generateVapidKeys() {
  const e = createECDH("prime256v1");
  e.generateKeys();
  return { publicKey: b64(e.getPublicKey()), privateKey: b64(e.getPrivateKey().length < 32 ? Buffer.concat([Buffer.alloc(32 - e.getPrivateKey().length), e.getPrivateKey()]) : e.getPrivateKey()) };
}

/**
 * RFC 8291 aes128gcm body: header (salt, record size, our public key) + one encrypted record.
 * `salt` and `asPrivate` are only given in tests, to reproduce the RFC's example.
 */
export function encryptPayload(plaintext: Buffer, keys: PushKeys, fixed: { salt?: Buffer; asPrivate?: Buffer } = {}): Buffer {
  const ua = Buffer.from(keys.p256dh, "base64url"), authSecret = Buffer.from(keys.auth, "base64url");
  if (ua.length !== 65 || ua[0] !== 4 || authSecret.length !== 16) throw permanent("push subscription keys are malformed");
  if (plaintext.length > MAX_PLAINTEXT) throw permanent("push message is too large");
  const ecdh = createECDH("prime256v1");
  if (fixed.asPrivate) ecdh.setPrivateKey(fixed.asPrivate); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const salt = fixed.salt ?? randomBytes(16);
  const secret = ecdh.computeSecret(ua);
  const ikm = Buffer.from(hkdfSync("sha256", secret, authSecret, Buffer.concat([Buffer.from("WebPush: info\0"), ua, asPublic]), 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, "Content-Encoding: aes128gcm\0", 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, "Content-Encoding: nonce\0", 12));
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const record = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]); // 0x02 = last record
  const header = Buffer.concat([salt, Buffer.from([0, 0, 0x10, 0, 65]), asPublic]); // record size 4096, key length 65
  return Buffer.concat([header, record]);
}

/** RFC 8292 token: ES256 JWT naming the push service (aud), our contact (sub) and an expiry under 24 hours. */
export function vapidAuthorization(endpoint: string, cfg: Pick<PushConfig, "publicKey" | "privateKey" | "subject">, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const pub = Buffer.from(cfg.publicKey, "base64url");
  const key = createPrivateKey({ key: { kty: "EC", crv: "P-256", x: b64(pub.subarray(1, 33)), y: b64(pub.subarray(33, 65)), d: cfg.privateKey }, format: "jwk" });
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${part({ typ: "JWT", alg: "ES256" })}.${part({ aud: new URL(endpoint).origin, exp: nowSeconds + 12 * 3600, sub: cfg.subject })}`;
  const sig = sign("sha256", Buffer.from(unsigned), { key, dsaEncoding: "ieee-p1363" }); // r||s, as JWT wants
  return `vapid t=${unsigned}.${b64(sig)}, k=${cfg.publicKey}`;
}

export function webpushNotify(fallback: NotifyPort, cfg: PushConfig): NotifyPort {
  const f = cfg.fetch ?? fetch;
  return {
    async send(p) {
      if (p.channel !== "push") return fallback.send(p);
      const keys = await cfg.lookup(p.to);
      if (!keys) throw permanent("push subscription no longer exists"); // removed already (browser unsubscribed, or an earlier 410)
      // The queue stores the title in `subject` and `{ body, url }` as JSON in `body`.
      const m = (() => { try { return JSON.parse(p.body) as { body?: string; url?: string }; } catch { return { body: p.body }; } })();
      const payload = Buffer.from(JSON.stringify({ title: p.subject ?? "Marichi", body: m.body ?? "", url: m.url }));
      const res = await f(p.to, {
        method: "POST",
        headers: {
          authorization: vapidAuthorization(p.to, cfg),
          "content-encoding": "aes128gcm", "content-type": "application/octet-stream",
          ttl: String(TTL_SECONDS), urgency: TEMPLATES[p.template]?.critical ? "high" : "normal",
        },
        body: new Uint8Array(encryptPayload(payload, keys)),
      });
      if (res.status === 404 || res.status === 410) { // the subscription is gone for good: forget it and stop retrying
        await cfg.remove(p.to);
        throw permanent(`push subscription expired (${res.status}) and was removed`);
      }
      // 400 = the push service refused this message (a retry sends the same thing), 413 = too large.
      if (res.status === 400 || res.status === 413) throw permanent(`push service rejected the message (${res.status}): ${(await res.text()).slice(0, 200)}`);
      // 201 Created is the documented success; anything else (401/403 bad VAPID setup, 429, 5xx) is thrown so the outbox retries.
      if (res.status !== 201) throw new Error(`push service answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return {};
    },
  };
}
