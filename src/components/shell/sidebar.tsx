"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon, Logo } from "@/components/ui/icons";
import { ORG_ROLE_LABEL, type OrgRole } from "@/server/permissions";
import { ROLE_META, type Item, type Section } from "./nav";

export type Workspace = { role: string; orgRole?: string; business: string | null; kyb: string | null; logoUrl?: string | null };

const initials = (n: string) => n.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();

/** Company mark: the uploaded picture, or the initials on the brand colour. */
export function CompanyMark({ name, logoUrl, className = "h-10 w-10" }: { name: string; logoUrl?: string | null; className?: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return logoUrl ? <img src={logoUrl} alt="" className={`${className} shrink-0 rounded-xl bg-card object-cover`} /> : <span aria-hidden className={`${className} grid shrink-0 place-items-center rounded-xl bg-p-700 text-sm font-bold text-white`}>{initials(name)}</span>;
}

const KYB: Record<string, { label: string; cls: string }> = {
  approved: { label: "Verified", cls: "bg-g-100 text-g-600" },
  under_review: { label: "In review", cls: "bg-s-100 text-s-600" },
  submitted: { label: "In review", cls: "bg-s-100 text-s-600" },
};
const kybChip = (s: string) => KYB[s] ?? { label: "Action needed", cls: "bg-r-100 text-r-600" };

function NavItem({ item, badge, collapsed, onNavigate }: { item: Item; badge?: number; collapsed: boolean; onNavigate: () => void }) {
  const path = usePathname();
  const active = path === item.href || (item.href !== "/dashboard" && item.href !== "/admin" && path.startsWith(item.href + "/"));
  return (
    <Link href={item.href} onClick={onNavigate} data-tour={item.tour} aria-current={active ? "page" : undefined} title={collapsed ? item.label : undefined}
      className={`group relative flex items-center gap-3 rounded-full py-2.5 text-[14.5px] font-medium transition-all duration-200 ${collapsed ? "justify-center px-2" : "px-4"} ${
        active ? "bg-p-100 text-p-800" : item.soon ? "text-faint hover:bg-panel hover:text-muted" : "text-muted hover:bg-panel hover:text-ink"}`}>
      <span aria-hidden className={`absolute top-1/2 -left-4 h-6 w-1.5 -translate-y-1/2 rounded-r-full bg-p-700 transition-all duration-300 ${active ? "scale-y-100 opacity-100" : "scale-y-0 opacity-0"}`} />
      <Icon name={item.icon} className={`h-5 w-5 shrink-0 transition-transform duration-200 group-hover:scale-110 ${active ? "text-p-700" : ""}`} />
      {!collapsed && <span className="flex-1 truncate">{item.label}</span>}
      {!collapsed && item.soon && <span className="rounded-full bg-panel px-2 py-px text-[10px] font-semibold tracking-wide text-faint uppercase">Soon</span>}
      {!collapsed && !!badge && <span className="grid min-w-6 place-items-center rounded-full bg-p-800 px-1.5 text-[11px] leading-6 font-bold text-white">{badge}</span>}
      {collapsed && !!badge && <span className="absolute top-1.5 right-3 h-2 w-2 rounded-full bg-r-600" />}
    </Link>
  );
}

export function Sidebar({ sections, badges, collapsed, ws, onNavigate, onToggle }: { sections: Section[]; badges: Record<string, number>; collapsed: boolean; ws: Workspace; onNavigate: () => void; onToggle?: () => void }) {
  const meta = ROLE_META[ws.role] ?? ROLE_META.seller;
  const staff = ["admin", "ops", "compliance"].includes(ws.role);
  const chip = ws.kyb && !staff ? kybChip(ws.kyb) : null;
  return (
    <div className="flex h-full flex-col bg-card">
      <div className={`flex h-[72px] shrink-0 items-center ${collapsed ? "justify-center" : "gap-3 px-6"}`}>
        <Link href={meta.home} onClick={onNavigate} className="flex min-w-0 items-center gap-3" aria-label={ws.business ? `${ws.business} home` : "Marichi home"}>
          {ws.business ? <CompanyMark name={ws.business} logoUrl={ws.logoUrl} /> : <Logo className="h-10 w-10" />}
          {!collapsed && (
            <span className="min-w-0 leading-tight">
              <span className="block truncate text-[18px] font-semibold tracking-tight text-ink">{ws.business ?? "Marichi"}</span>
              {ws.business && <span className="block text-[11px] text-faint">Powered by Marichi</span>}
            </span>
          )}
        </Link>
      </div>

      {!collapsed && (
        <div data-tour="workspace" className="mx-4 rounded-card bg-panel p-4">
          <p className="text-[10.5px] font-semibold tracking-[.1em] text-p-700 uppercase">{meta.workspace}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {chip ? <span className={`pill ${chip.cls}`}>{chip.label}</span> : <span className="pill bg-p-100 text-p-700">{meta.label}</span>}
            {ws.orgRole && !staff && <span className="pill bg-card text-muted ring-1 ring-hair">{ORG_ROLE_LABEL[ws.orgRole as OrgRole] ?? ws.orgRole}</span>}
            <span className="truncate text-xs text-faint">{chip ? "KYB" : "Staff account"}</span>
          </div>
        </div>
      )}

      <nav aria-label="Primary" className="scroll-thin mt-5 flex-1 space-y-6 overflow-y-auto px-4 pb-4">
        {sections.map((s) => (
          <div key={s.label}>
            {collapsed ? <div className="mx-3 mb-2 border-t border-hair" /> : <p className="px-4 pb-2 text-[11.5px] font-semibold tracking-[.08em] text-faint uppercase">{s.label}</p>}
            <div className="space-y-1">{s.items.map((i) => <NavItem key={i.href} item={i} badge={badges[i.href]} collapsed={collapsed} onNavigate={onNavigate} />)}</div>
          </div>
        ))}
      </nav>

      {!collapsed && (
        <div className="mx-4 mb-3 rounded-card bg-p-800 p-4 text-sm text-p-100">
          <p className="font-semibold text-white">Need a hand?</p>
          <p className="mt-1 text-p-100/80">{staff ? "Open the support queue for customer requests." : "Raise a request and we respond within a day."}</p>
          <Link href={staff ? "/admin/support" : "/support"} onClick={onNavigate} className="mt-3 inline-block rounded-full bg-white px-4 py-1.5 text-[13px] font-semibold text-p-800 transition-transform hover:scale-[1.03]">{staff ? "Support queue" : "Contact support"}</Link>
        </div>
      )}
      {onToggle && (
        <button onClick={onToggle} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} className="mx-4 mb-4 hidden items-center justify-center gap-3 rounded-full py-2.5 text-sm text-muted transition-colors hover:bg-panel hover:text-ink lg:flex">
          <Icon name="panel-left" className="h-5 w-5" />{!collapsed && "Collapse"}
        </button>
      )}
    </div>
  );
}
