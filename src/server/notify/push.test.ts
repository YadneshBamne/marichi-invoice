import { describe, expect, it } from "vitest";
import { createECDH } from "node:crypto";
import { isPushEndpoint, PushSubscriptionBody } from "./push";

const e = createECDH("prime256v1");
e.generateKeys();
const keys = { p256dh: e.getPublicKey().toString("base64url"), auth: Buffer.alloc(16, 7).toString("base64url") };

describe("push subscription validation", () => {
  it("accepts https endpoints at the real push services only", () => {
    for (const u of ["https://fcm.googleapis.com/fcm/send/abc", "https://updates.push.services.mozilla.com/wpush/v2/abc", "https://web.push.apple.com/abc", "https://wns2-par02p.notify.windows.com/w/?token=x"]) expect(isPushEndpoint(u), u).toBe(true);
    for (const u of ["http://fcm.googleapis.com/x", "https://localhost/x", "https://127.0.0.1/x", "https://169.254.169.254/latest", "https://fcm.googleapis.com.example.com/x", "https://fcm.googleapis.com:8443/x", "https://user@fcm.googleapis.com/x", "https://notfcm.googleapis.com.evil.io", "nonsense", ""]) expect(isPushEndpoint(u), u).toBe(false);
  });
  it("checks the keys: 65-byte uncompressed public key, 16-byte auth secret", () => {
    const endpoint = "https://fcm.googleapis.com/fcm/send/abc";
    expect(PushSubscriptionBody.safeParse({ endpoint, keys }).success).toBe(true);
    expect(PushSubscriptionBody.safeParse({ endpoint, keys: { ...keys, auth: "AAAA" } }).success).toBe(false);
    expect(PushSubscriptionBody.safeParse({ endpoint, keys: { ...keys, p256dh: "AAAA" } }).success).toBe(false);
    expect(PushSubscriptionBody.safeParse({ endpoint, keys: { ...keys, p256dh: keys.p256dh + "=" } }).success).toBe(false);
    expect(PushSubscriptionBody.safeParse({ endpoint: "https://x.example.com/a", keys }).success).toBe(false);
    expect(PushSubscriptionBody.safeParse({ endpoint }).success).toBe(false);
  });
});
