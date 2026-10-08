import { requireUser } from "@/server/rbac";
import { PageHead } from "@/components/ui/page";
import { Importer } from "./importer";

export const metadata = { title: "Import invoices" };

export default async function ImportPage() {
  await requireUser(["seller"]);
  return (
    <>
      <PageHead back={{ href: "/seller/invoices", label: "Invoices" }} title="Import invoices" sub="Bring invoices in from your accounting system as a spreadsheet. Each one goes through the same checks as an upload, and your buyer is asked to confirm it." />
      <Importer />
    </>
  );
}
