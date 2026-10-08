import { LegalPage } from "@/components/ui/legal";

export const metadata = { title: "Terms of use" };

export default function Terms() {
  return (
    <LegalPage title="Terms of use" updated="7 October 2026" sections={[
      { h: "About the service", p: ["Marichi Labs provides a platform on which businesses (sellers) can offer approved invoices for early payment, and on which their customers (buyers) confirm and settle those invoices.", "Financing offers are subject to verification, underwriting and the terms of the agreement you sign for each transaction."] },
      { h: "Your account", p: ["You must provide accurate information and keep your credentials secure. Two-factor authentication is required on every account.", "You are responsible for activity under your account and for telling us promptly if you suspect it has been compromised."] },
      { h: "Invoices and confirmations", p: ["You may only submit invoices that are genuine, undisputed and owned by your business. Submitting a false, duplicate or already-financed invoice is a breach of these terms and may be reported to the relevant authorities.", "A buyer's confirmation is a statement that the invoice is valid and will be paid on its due date to the collection account shown."] },
      { h: "Fees and charges", p: ["Every offer states the advance amount, processing fee, applicable taxes and the discount charged for the period, before you accept. Late payment may attract penal charges as stated in your agreement."] },
      { h: "Acceptable use", p: ["You must not misuse the service, attempt to access data that is not yours, interfere with its operation, or use it for unlawful activity."] },
      { h: "Complaints", p: ["If something goes wrong, raise a request from your account. Our grievance redressal process and escalation path are described on the grievance page."] },
      { h: "Changes to these terms", p: ["We may update these terms. We will notify you of material changes before they apply."] },
    ]} />
  );
}
