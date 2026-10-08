import { describe, expect, it, vi } from "vitest";
import { resendNotify } from "./resend-email";
import { mock } from "./mock";

const msg = { channel: "email" as const, to: "a@b.com", template: "t", data: {}, subject: "Hello", body: "Body text" };

describe("Resend email adapter", () => {
  it("posts the rendered message and returns the provider id", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ id: "re_123" }), { status: 200 }));
    const n = resendNotify(mock.notify, { apiKey: "key", from: "Marichi <no-reply@x.com>", fetch: f as unknown as typeof fetch });
    expect(await n.send(msg)).toEqual({ providerRef: "re_123" });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer key");
    expect(JSON.parse(init.body as string)).toEqual({ from: "Marichi <no-reply@x.com>", to: ["a@b.com"], subject: "Hello", text: "Body text" });
  });
  it("throws on a provider error so the outbox retries, and leaves SMS to the fallback port", async () => {
    const bad = vi.fn(async () => new Response("domain not verified", { status: 403 }));
    const n = resendNotify(mock.notify, { apiKey: "key", from: "x", fetch: bad as unknown as typeof fetch });
    await expect(n.send(msg)).rejects.toThrow(/403/);
    const sms = await n.send({ ...msg, channel: "sms", to: "+919876543210" });
    expect(sms?.providerRef).toMatch(/^MOCKMSG-/);
    expect(bad).toHaveBeenCalledTimes(1); // the SMS never touched the email provider
  });
});
