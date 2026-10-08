import { requireUser } from "@/server/rbac";
import { SecurityPanels } from "./panels";

export const metadata = { title: "Security" };

export default async function Security() {
  await requireUser();
  return <SecurityPanels />;
}
