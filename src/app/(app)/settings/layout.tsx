import { PageHead } from "@/components/ui/cards";
import { SettingsTabs } from "./tabs";

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-4xl">
      <PageHead title="Settings" sub="Your profile, organisation, security and notifications." />
      <SettingsTabs />
      <div className="mt-6">{children}</div>
    </div>
  );
}
