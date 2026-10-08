import { LegalPage } from "@/components/ui/legal";

export const metadata = { title: "Privacy notice" };

export default function Privacy() {
  return (
    <LegalPage title="Privacy notice" updated="7 October 2026" sections={[
      { h: "What we collect", p: ["Account details (name, email, mobile number), business details (legal name, PAN, GSTIN, directors and beneficial owners, bank account), the invoices you upload, and records of how you use the service."] },
      { h: "Why we use it", p: ["To verify your business, assess financing eligibility, move and reconcile money, meet legal and regulatory obligations, prevent fraud, and provide support."] },
      { h: "Credit information", p: ["We obtain credit information from credit bureaus only with your recorded consent, and only for assessing eligibility."] },
      { h: "Who we share it with", p: ["Verification, payment, e-signature and messaging providers acting on our behalf, our financing partners, and authorities where the law requires. We do not sell personal data."] },
      { h: "How long we keep it", p: ["Financial and audit records are kept for the period the law requires. Other data is kept only as long as it is needed for the purposes above."] },
      { h: "Your rights", p: ["You can ask to access or correct your data, and to raise concerns about how it is handled. Use the support page or the grievance officer's contact details."] },
      { h: "Security", p: ["Access is protected by two-factor authentication and role-based permissions, and every sensitive change is written to an audit log."] },
    ]} />
  );
}
