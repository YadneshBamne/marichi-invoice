import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/server/db/client";
import { requireUser } from "@/server/rbac";
import { listUsers, setStaffRole } from "@/server/admin/service";
import { cancelStaffInvitation, inviteStaff, listStaffInvitations, resendStaffInvitation } from "@/server/admin/staff";
import { STAFF_ROLES } from "@/server/support/policy";
import { DataTable, Notice, PageHead, Panel, Pop, PopField } from "@/components/ui/page";
import { Icon } from "@/components/ui/icons";

export const metadata = { title: "Users and roles" };
const form = z.object({ userId: z.uuid(), role: z.enum(["ops", "admin", "compliance"]) });

async function change(fd: FormData) {
  "use server";
  const u = await requireUser(["admin"]);
  const f = form.parse(Object.fromEntries(fd));
  await setStaffRole(db, u, f.userId, f.role);
  revalidatePath("/admin/users");
}

async function invite(fd: FormData) {
  "use server";
  const u = await requireUser(["admin"]);
  const f = z.object({ email: z.string(), role: z.enum(["ops", "admin", "compliance"]) }).parse(Object.fromEntries(fd));
  await inviteStaff(db, u, f);
  revalidatePath("/admin/users");
}
async function resend(fd: FormData) {
  "use server";
  const u = await requireUser(["admin"]);
  await resendStaffInvitation(db, u, z.uuid().parse(fd.get("id")));
  revalidatePath("/admin/users");
}
async function cancel(fd: FormData) {
  "use server";
  const u = await requireUser(["admin"]);
  await cancelStaffInvitation(db, u, z.uuid().parse(fd.get("id")));
  revalidatePath("/admin/users");
}

export default async function Users({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const me = await requireUser(["admin"]);
  const q = (await searchParams).q;
  const [rows, invites] = await Promise.all([listUsers(db, q), listStaffInvitations(db)]);
  return (
    <>
      <PageHead title="Users and roles" sub="Every account on the platform. Staff roles can be changed here; customers cannot be promoted to staff.">
        <form className="relative">
          <Icon name="search" className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-faint" />
          <input name="q" defaultValue={q} placeholder="Search by email" className="field-inline !rounded-full !py-2 pr-4 pl-10 text-sm" />
        </form>
      </PageHead>
      <div className="mb-4"><Notice>New staff join by emailed invitation: they choose their own password and set up two-step verification. You cannot change your own role.</Notice></div>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <Pop id="invite-staff" label="Invite staff" cls="btn btn-primary btn-sm">
          <form action={invite} className="space-y-2">
            <PopField label="Work email"><input name="email" type="email" required className="field !py-2 text-sm font-normal" /></PopField>
            <PopField label="Role"><select name="role" defaultValue="ops" className="field !py-2 text-sm font-normal capitalize">{STAFF_ROLES.map((s) => <option key={s}>{s}</option>)}</select></PopField>
            <button className="btn btn-primary btn-sm w-full">Send invitation</button>
          </form>
        </Pop>
      </div>
      {invites.length > 0 && (
        <Panel title="Waiting to join" className="mb-5" flush>
          <DataTable rows={invites} rowKey={(r) => r.id}
            cols={[
              { h: "Email", cell: (r) => r.email },
              { h: "Role", cell: (r) => <span className="font-normal capitalize text-muted">{r.role}</span> },
              { h: "Link", cell: (r) => <span className="font-normal text-muted">{r.expired ? "Expired" : `Valid until ${r.expiresAt.toISOString().slice(0, 10)}`}</span> },
              { h: "", align: "right", cell: (r) => (
                <span className="inline-flex gap-2">
                  <form action={resend}><input type="hidden" name="id" value={r.id} /><button className="btn btn-ghost btn-sm">Resend</button></form>
                  <form action={cancel}><input type="hidden" name="id" value={r.id} /><button className="btn btn-ghost btn-sm">Cancel</button></form>
                </span>
              ) },
            ]} />
        </Panel>
      )}
      <Panel flush>
        <DataTable rows={rows} rowKey={(r) => r.id} empty="No users match."
          cols={[
            { h: "Name", cell: (r) => r.name },
            { h: "Email", cell: (r) => <span className="font-normal text-muted">{r.email}</span> },
            { h: "Role", cell: (r) => (STAFF_ROLES as string[]).includes(r.role) && r.id !== me.id ? (
              <form action={change} className="flex items-center gap-1.5">
                <input type="hidden" name="userId" value={r.id} />
                <select name="role" defaultValue={r.role} className="field-inline !py-1 text-sm capitalize">{STAFF_ROLES.map((s) => <option key={s}>{s}</option>)}</select>
                <button className="btn btn-ghost btn-sm">Save</button>
              </form>
            ) : <span className="capitalize">{r.role}{r.id === me.id && <span className="ml-1 text-faint">(you)</span>}</span> },
            { h: "Two-factor", cell: (r) => r.mfa ? <span className="pill bg-g-100 text-g-600">On</span> : <span className="pill bg-r-100 text-r-600">Off</span> },
            { h: "KYC", cell: (r) => <span className="capitalize text-muted">{String(r.kyc).replaceAll("_", " ")}</span> },
          ]} />
      </Panel>
    </>
  );
}
