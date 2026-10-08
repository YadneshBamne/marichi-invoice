// Real email delivery through Resend (https://resend.com). Needs RESEND_API_KEY and MAIL_FROM on a domain verified in Resend.
// SMS is not handled here: it stays on the fallback port until an SMS provider and the DLT registration exist.
import type { NotifyPort } from "./gateway";

export function resendNotify(fallback: NotifyPort, cfg: { apiKey: string; from: string; fetch?: typeof fetch }): NotifyPort {
  const f = cfg.fetch ?? fetch;
  return {
    async send(p) {
      if (p.channel !== "email") return fallback.send(p);
      const res = await f("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${cfg.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ from: cfg.from, to: [p.to], subject: p.subject ?? "Notification from Marichi", text: p.body }),
      });
      if (!res.ok) throw new Error(`email provider rejected the message (${res.status}): ${(await res.text()).slice(0, 200)}`); // thrown so the outbox retries
      const j = (await res.json().catch(() => ({}))) as { id?: string };
      return { providerRef: j.id };
    },
  };
}
