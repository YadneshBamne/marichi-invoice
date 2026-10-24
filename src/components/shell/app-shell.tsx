"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Dialog } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icons";
import { Tour } from "@/components/tour/tour";
import { CRUMBS, ROLE_META, navFor } from "./nav";
import { HelpMenu, NotificationMenu, UserMenu, type InboxItem } from "./menus";
import { CommandPalette } from "./palette";
import { Sidebar, type Workspace } from "./sidebar";
import { ORG_ROLE_LABEL, type OrgRole } from "@/server/permissions";

export type ShellProps = {
  user: { name: string; email: string; role: string; orgRole?: string };
  business: { name: string; kyb: string; logoUrl?: string | null } | null;
  apps?: string[]; // enabled company apps
  picked?: string[]; // owner's raw selection (includes followed roadmap modules)
  sandbox: boolean;
  badges: Record<string, number>;
  inbox: InboxItem[];
  companies?: { id: string; name: string; kind: string | null; active: boolean }[];
  tourSeen: boolean;
  children: ReactNode;
};

// "/admin", "/seller", "/buyer" and "/soon" are routing prefixes, not pages, so they get no crumb of their own.
const PREFIXES = new Set(["/admin", "/seller", "/buyer", "/soon"]);

function Crumbs({ home, homeLabel }: { home: string; homeLabel: string }) {
  const parts = usePathname().split("/").filter(Boolean);
  const crumbs = parts
    .map((p, i) => ({
      href: "/" + parts.slice(0, i + 1).join("/"),
      label: CRUMBS[p] ?? (/^[0-9a-f-]{8,}$/i.test(p) ? "Details" : p.replaceAll("-", " ").replace(/^./, (c) => c.toUpperCase())),
    }))
    .filter((c, i, a) => !(i < a.length - 1 && PREFIXES.has(c.href)) && c.href !== home);
  return (
    <nav aria-label="Breadcrumb" className="mb-5 hidden min-w-0 items-center gap-1.5 text-[13.5px] md:flex">
      <Link href={home} className="text-muted transition-colors hover:text-ink">{homeLabel}</Link>
      {crumbs.map((c, i) => (
        <span key={c.href} className="flex min-w-0 items-center gap-1.5">
          <Icon name="chevron-right" className="h-3.5 w-3.5 shrink-0 text-faint" />
          {i === crumbs.length - 1
            ? <span aria-current="page" className="truncate font-semibold">{c.label}</span>
            : <Link href={c.href} className="truncate text-muted transition-colors hover:text-ink">{c.label}</Link>}
        </span>
      ))}
    </nav>
  );
}

export function AppShell({ user, business, apps, picked, sandbox, badges, inbox, companies, tourSeen, children }: ShellProps) {
  const router = useRouter();
  const path = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [palette, setPalette] = useState(false);
  const [keys, setKeys] = useState(false);
  const [tourOpen, setTourOpen] = useState(false);
  const sections = useMemo(() => navFor(user.role, { apps, picked, orgRole: user.orgRole }), [user.role, user.orgRole, apps, picked]);
  const meta = ROLE_META[user.role] ?? ROLE_META.seller;
  const staff = ["admin", "ops", "compliance"].includes(user.role);
  const ws: Workspace = { role: user.role, orgRole: user.orgRole, business: business?.name ?? null, kyb: business?.kyb ?? null, logoUrl: business?.logoUrl ?? null };
  const roleLabel = staff || !user.orgRole ? meta.label : `${ORG_ROLE_LABEL[user.orgRole as OrgRole] ?? ""} · ${meta.label}`;

  useEffect(() => { try { setCollapsed(localStorage.getItem("marichi:sidebar") === "1"); } catch { /* storage blocked: default expanded */ } }, []);
  useEffect(() => { setDrawer(false); }, [path]);
  const toggle = () => setCollapsed((c) => { try { localStorage.setItem("marichi:sidebar", c ? "0" : "1"); } catch { /* ignore */ } return !c; });

  // Ctrl/Cmd+K opens search from anywhere. The tour opens/closes the mobile drawer through the shell:nav event.
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPalette((o) => !o); } };
    const nav = (e: Event) => setDrawer(Boolean((e as CustomEvent<boolean>).detail));
    window.addEventListener("keydown", key); window.addEventListener("shell:nav", nav);
    return () => { window.removeEventListener("keydown", key); window.removeEventListener("shell:nav", nav); };
  }, []);

  const startTour = useCallback(() => setTourOpen(true), []);
  const actions = useMemo(() => [
    { label: "Take the product tour", icon: "play", run: startTour },
    { label: "Keyboard shortcuts", icon: "keyboard", run: () => setKeys(true) },
    ...(user.role === "seller" ? [{ label: "Upload an invoice", icon: "upload", run: () => router.push("/seller/invoices") }] : []),
    ...(!staff && (!apps || apps.includes("support")) ? [{ label: "Raise a support request", icon: "mail", run: () => router.push("/support") }] : []),
    { label: "Open grievance redressal", icon: "flag", run: () => router.push("/grievance") },
  ], [user.role, staff, apps, router, startTour]);

  return (
    <div data-role={user.role} className="min-h-dvh bg-page p-3 lg:p-4">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[100] focus:rounded-lg focus:bg-card focus:px-4 focus:py-2 focus:shadow-pop">Skip to content</a>

      <aside data-tour="sidebar" className={`fixed top-4 bottom-4 left-4 z-30 hidden overflow-hidden rounded-panel shadow-card transition-[width] duration-300 lg:block ${collapsed ? "w-[88px]" : "w-[17rem]"}`}>
        <Sidebar sections={sections} badges={badges} collapsed={collapsed} ws={ws} onNavigate={() => {}} onToggle={toggle} />
      </aside>

      {drawer && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="anim-in absolute inset-0 bg-p-950/55" onClick={() => setDrawer(false)} />
          <aside className="absolute inset-y-2 left-2 w-[17rem] max-w-[85vw] overflow-hidden rounded-panel shadow-pop" style={{ animation: "var(--animate-slide-in)" }} data-tour="sidebar-mobile">
            <button onClick={() => setDrawer(false)} aria-label="Close menu" className="absolute top-5 right-4 z-10 grid h-9 w-9 place-items-center rounded-full bg-panel text-muted hover:bg-p-100"><Icon name="close" className="h-4 w-4" /></button>
            <Sidebar sections={sections} badges={badges} collapsed={false} ws={ws} onNavigate={() => setDrawer(false)} />
          </aside>
        </div>
      )}

      <div className={`transition-[padding] duration-300 ${collapsed ? "lg:pl-[7rem]" : "lg:pl-[18.5rem]"}`}>
        <header className="sticky top-3 z-20 flex h-[72px] items-center gap-3 rounded-panel bg-card px-3 shadow-card sm:px-5 lg:top-4">
          <button onClick={() => setDrawer(true)} aria-label="Open menu" className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-panel text-muted transition-colors hover:bg-p-100 lg:hidden"><Icon name="menu" /></button>
          <button onClick={() => setPalette(true)} data-tour="search" aria-label="Search" className="group hidden h-12 min-w-0 max-w-md flex-1 items-center gap-3 rounded-full bg-page px-5 text-sm text-faint transition-all hover:bg-panel hover:shadow-card sm:flex">
            <Icon name="search" className="h-[18px] w-[18px] shrink-0 transition-transform group-hover:scale-110" /><span className="flex-1 truncate text-left">Search pages and actions</span><kbd className="rounded-md bg-card px-2 py-0.5 text-[11px] font-semibold text-muted shadow-card">Ctrl K</kbd>
          </button>
          <span className="truncate text-[15px] font-semibold sm:hidden">{meta.workspace}</span>

          <div className="ml-auto flex shrink-0 items-center gap-2">
            <button onClick={() => setPalette(true)} aria-label="Search" className="grid h-11 w-11 place-items-center rounded-full bg-panel text-muted hover:bg-p-100 sm:hidden"><Icon name="search" className="h-[18px] w-[18px]" /></button>
            {sandbox && <span title="Integrations are simulated. No real money moves and no real KYC checks run." className="pill hidden bg-s-100 text-s-600 md:inline-flex" data-tour="sandbox">Sandbox</span>}
            <NotificationMenu items={inbox} />
            <HelpMenu staff={staff} onTour={startTour} onShortcuts={() => setKeys(true)} />
            <UserMenu user={user} roleLabel={roleLabel} business={business?.name ?? null} companies={companies ?? []} onTour={startTour} />
          </div>
        </header>

        <main id="main" className="app-main mt-3 min-h-[calc(100dvh-8.5rem)] rounded-panel bg-panel p-4 sm:p-6 lg:mt-4 lg:p-8">
          <div className="mx-auto max-w-[1360px]">
            <Crumbs home={meta.home} homeLabel={staff ? "Console" : "Home"} />
            {children}
          </div>
        </main>
        <footer className="flex flex-wrap items-center gap-x-5 gap-y-1 px-4 pt-4 pb-2 text-xs text-faint">
          <span>&copy; {new Date().getFullYear()} Marichi Labs</span>
          <Link className="hover:text-ink" href="/grievance">Grievance redressal</Link>
          <Link className="hover:text-ink" href="/terms">Terms</Link>
          <Link className="hover:text-ink" href="/privacy">Privacy</Link>
        </footer>
      </div>

      <CommandPalette open={palette} onClose={() => setPalette(false)} sections={sections} actions={actions} />
      <Dialog open={keys} onClose={() => setKeys(false)} label="Keyboard shortcuts" className="max-w-md">
        <div className="p-6">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Keyboard shortcuts</h2>
            <button onClick={() => setKeys(false)} aria-label="Close" className="grid h-8 w-8 place-items-center rounded-lg hover:bg-panel"><Icon name="close" className="h-4 w-4" /></button>
          </div>
          <dl className="mt-4 divide-y divide-hair text-sm">
            {([["Search pages and actions", "Ctrl K"], ["Close any dialog or menu", "Esc"], ["Next or previous tour step", "Right / Left"], ["Skip the tour", "Esc"]] as const).map(([a, k]) => (
              <div key={a} className="flex items-center justify-between py-2.5"><dt>{a}</dt><dd><kbd className="rounded border border-hair bg-page px-2 py-0.5 text-xs">{k}</kbd></dd></div>
            ))}
          </dl>
          <p className="mt-3 text-xs text-faint">On a Mac, use Cmd instead of Ctrl.</p>
        </div>
      </Dialog>
      <Tour role={user.role} firstName={user.name.split(" ")[0]} autoStart={!tourSeen} open={tourOpen} onOpen={() => setTourOpen(true)} onClose={() => setTourOpen(false)} />
    </div>
  );
}
