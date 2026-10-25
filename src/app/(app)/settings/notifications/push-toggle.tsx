"use client";
import { useEffect, useState } from "react";

// Browser notifications (Web Push) for this browser only: turning it on here does not affect your other browsers or devices.
const KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";
const keyBytes = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const post = (method: "POST" | "DELETE", body: unknown) => fetch("/api/push/subscribe", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export function PushToggle() {
  const [state, setState] = useState<"checking" | "unsupported" | "off" | "on" | "blocked">("checking");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const supported = !!KEY && "serviceWorker" in navigator && "PushManager" in window;
    (supported ? navigator.serviceWorker.register("/sw.js").then((reg) => reg.pushManager.getSubscription()) : Promise.reject(new Error("unsupported")))
      .then((s) => setState(s ? "on" : Notification.permission === "denied" ? "blocked" : "off"))
      .catch(() => setState("unsupported"));
  }, []);

  async function turnOn() {
    setBusy(true); setError("");
    try {
      if ((await Notification.requestPermission()) !== "granted") { setState("blocked"); return; }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(KEY) });
      const res = await post("POST", sub.toJSON());
      if (!res.ok) { await sub.unsubscribe(); setError(await res.text()); return; }
      setState("on");
    } catch { setError("Could not turn on notifications in this browser."); } finally { setBusy(false); }
  }

  async function turnOff() {
    setBusy(true); setError("");
    try {
      const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
      if (sub) { await post("DELETE", { endpoint: sub.endpoint }); await sub.unsubscribe(); }
      setState("off");
    } catch { setError("Could not turn off notifications in this browser."); } finally { setBusy(false); }
  }

  return (
    <section className="space-y-3 rounded-card bg-card p-5 shadow-card">
      <h2 className="font-medium">Browser notifications</h2>
      {state === "unsupported" && <p className="text-muted">This browser cannot receive notifications here, or they are not set up on this server yet.</p>}
      {state === "blocked" && <p className="text-muted">Notifications are blocked for this site. Allow them in your browser&apos;s site settings, then come back.</p>}
      {(state === "off" || state === "on") && (
        <>
          <p className="text-muted">{state === "on" ? "On for this browser. Important notices pop up even when this site is closed." : "Get important notices (payouts, overdue invoices, legal notices) as a pop-up in this browser. It applies to this browser only."}</p>
          <button type="button" disabled={busy} onClick={state === "on" ? turnOff : turnOn} className="btn btn-ghost btn-sm">{state === "on" ? "Turn off" : "Turn on"}</button>
        </>
      )}
      {error && <p role="alert" className="text-s-600">{error}</p>}
    </section>
  );
}
