"use client";
import { useCallback, useEffect, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { Card, Pill } from "@/components/ui/cards";

type Sess = { id: string; token: string; userAgent?: string | null; ipAddress?: string | null; createdAt: Date | string };

const device = (ua?: string | null) => {
  if (!ua) return "Unknown device";
  const b = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const o = /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "macOS" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Linux/.test(ua) ? "Linux" : "";
  return o ? `${b} on ${o}` : b;
};

export function SecurityPanels() {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [sessions, setSessions] = useState<Sess[]>([]);
  const [current, setCurrent] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [l, c] = await Promise.all([authClient.listSessions(), authClient.getSession()]);
    setSessions((l.data ?? []) as Sess[]);
    setCurrent(c.data?.session.token ?? null);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function changePassword(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setMsg(null);
    const f = new FormData(e.currentTarget);
    if (f.get("next") !== f.get("confirm")) return setMsg({ ok: false, text: "The new passwords don't match." });
    const { error } = await authClient.changePassword({ currentPassword: String(f.get("current")), newPassword: String(f.get("next")), revokeOtherSessions: true });
    if (error) return setMsg({ ok: false, text: error.message ?? "Could not change the password." });
    (e.target as HTMLFormElement).reset();
    setMsg({ ok: true, text: "Password changed. Other devices have been signed out." }); load();
  }
  async function regenerate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setMsg(null);
    const f = new FormData(e.currentTarget);
    const { data, error } = await authClient.twoFactor.generateBackupCodes({ password: String(f.get("password")) });
    if (error || !data) return setMsg({ ok: false, text: error?.message ?? "Could not generate backup codes." });
    setCodes(data.backupCodes); (e.target as HTMLFormElement).reset();
  }
  const revoke = async (token: string) => { await authClient.revokeSession({ token }); load(); };

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {msg && <p role="status" className={`anim-pop rounded-lg px-4 py-3 text-sm lg:col-span-2 ${msg.ok ? "bg-g-100 text-g-600" : "bg-r-100 text-r-600"}`}>{msg.text}</p>}

      <Card title="Change password">
        <form onSubmit={changePassword} className="space-y-3 text-sm">
          <label className="block font-medium">Current password<input name="current" type="password" required autoComplete="current-password" className="field font-normal" /></label>
          <label className="block font-medium">New password<input name="next" type="password" required minLength={10} autoComplete="new-password" className="field font-normal" /></label>
          <label className="block font-medium">Confirm new password<input name="confirm" type="password" required minLength={10} autoComplete="new-password" className="field font-normal" /></label>
          <p className="text-xs text-muted">At least 10 characters. Changing it signs you out everywhere else.</p>
          <button className="btn btn-primary">Update password</button>
        </form>
      </Card>

      <Card title="Two-factor authentication" action={<Pill tone="good">Enabled</Pill>}>
        <p className="text-sm text-muted">Required on every account. Each sign-in asks for a code from your authenticator app.</p>
        <form onSubmit={regenerate} className="mt-4 space-y-3 border-t border-hair pt-4 text-sm">
          <p className="font-medium">Backup codes</p>
          <p className="text-xs text-muted">Use a backup code if you lose your phone. Generating new codes cancels the old ones.</p>
          <div className="flex gap-2"><input name="password" type="password" required placeholder="Confirm your password" autoComplete="current-password" className="field-inline min-w-0 flex-1" /><button className="btn btn-ghost btn-sm">Generate</button></div>
        </form>
        {codes && (
          <div className="anim-pop mt-3 rounded-lg bg-page p-3">
            <p className="text-xs font-semibold text-muted">Save these now. They are shown once.</p>
            <pre className="mt-2 font-mono text-sm leading-6">{codes.join("\n")}</pre>
          </div>
        )}
      </Card>

      <Card title="Active sessions" className="lg:col-span-2" action={sessions.length > 1 ? <button className="btn btn-ghost btn-sm" onClick={async () => { await authClient.revokeOtherSessions(); load(); }}>Sign out other devices</button> : null}>
        <ul className="divide-y divide-hair text-sm">
          {sessions.length === 0 && <li className="py-3 text-muted">Loading…</li>}
          {sessions.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <span><b>{device(s.userAgent)}</b>{s.token === current && <span className="pill ml-2 bg-g-100 text-g-600">This device</span>}<span className="block text-xs text-muted">{s.ipAddress ?? "Unknown IP"} · signed in {new Date(s.createdAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</span></span>
              {s.token !== current && <button className="btn btn-ghost btn-sm" onClick={() => revoke(s.token)}>Sign out</button>}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
