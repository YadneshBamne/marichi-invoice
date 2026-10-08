import { PageHead } from "@/components/ui/cards";
import { requireUser } from "@/server/rbac";
import { SettingsTabs } from "./tabs";

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const u = await requireUser();
  const integrations = u.apps.has("integrations");
  return (
    <div className="mx-auto max-w-4xl">
      <PageHead title="Settings" sub="Your profile, organisation, security and notifications." />
      <SettingsTabs integrations={integrations} />
      <div className="mt-6">{children}</div>
    </div>
  );
}
