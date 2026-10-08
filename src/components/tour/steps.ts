// Guided tour content. `target` is a data-tour id in the shell or a page; a step without a target is a centred card.
// `optional` steps are skipped silently when their target isn't on screen (e.g. a page widget while on another page).
export type Step = {
  id: string; title: string; body: string; target?: string; optional?: boolean; nav?: boolean;
  flow?: string[]; nextLabel?: string; cta?: { label: string; href: string };
};

const welcome = (first: string, body: string, flow: string[]): Step => ({
  id: "welcome", title: `Welcome to Marichi, ${first}`, body: `${body} The tour takes about two minutes. You can skip it now and replay it any time from the Help menu.`, flow, nextLabel: "Start tour",
});
const workspace = (body: string): Step => ({ id: "workspace", target: "workspace", nav: true, title: "Your workspace", body });
const nav = (id: string, title: string, body: string, optional = false): Step => ({ id, target: id, nav: true, title, body, optional });

const shared = (role: "customer" | "staff"): Step[] => [
  nav("nav-soon", "Coming soon", "Planned modules appear here, each with what it will do. They are not available yet, and opening one tells you exactly what is on the way.", true),
  { id: "search", target: "search", title: "Search and jump", body: "Press Ctrl K (Cmd K on a Mac) to open search from anywhere. Jump to any page or start a common action without touching the menu." },
  { id: "notifications", target: "notifications", title: "Notifications", body: "Offers, payouts, payments due and anything that needs you show up here. Important notices are always sent by email as well." },
  { id: "help", target: "help", title: "Help", body: role === "customer" ? "Replay this tour, contact support, or use grievance redressal. Every request gets a tracked ticket with a response time." : "Replay this tour, open the support queue, or review the keyboard shortcuts." },
  { id: "user-menu", target: "user-menu", title: "Your account", body: "Profile, security settings and sign out. Two-factor authentication is required on every account and is managed under Security." },
  { id: "sandbox", target: "sandbox", optional: true, title: "Sandbox mode", body: "This environment simulates banks, KYC and e-sign providers. No real money moves, so it is safe to try everything." },
];

export function stepsFor(role: string, first: string): Step[] {
  if (role === "seller") return [
    welcome(first, "Marichi turns your unpaid invoices into cash within about a day.", [
      "Verify your business (KYB)", "Add the buyers who owe you money", "Upload an invoice; your buyer confirms it", "Review the offer and e-sign the agreement", "Receive the advance in your bank account", "Your buyer pays on the due date; any remainder comes back to you",
    ]),
    workspace("This panel shows which account you are in and your verification status. You need to be verified before any invoice can be financed."),
    nav("nav-dashboard", "Dashboard", "Available credit, what is outstanding, an invoice pipeline and the repayment schedule, all in one view."),
    { id: "setup", target: "setup", optional: true, title: "Get started checklist", body: "Four steps from sign-up to your first payout. It highlights the next one to do and disappears once you have been funded." },
    { id: "kpis", target: "kpis", optional: true, title: "Your numbers", body: "Available credit is your limit minus what is outstanding. Fees and discount show the all-in cost of financing so far." },
    { id: "todo", target: "todo", optional: true, title: "Needs your attention", body: "Offers waiting for an answer, documents to sign, late invoices and open disputes. Each row opens the right screen." },
    nav("nav-invoices", "Invoices", "Upload invoices and follow each one through buyer confirmation, offer, funding and repayment. Duplicates and bad e-invoice numbers are caught on upload."),
    nav("nav-buyers", "Buyers", "Invite the businesses that owe you money. A buyer must be linked and verified before their invoices can be financed."),
    nav("nav-agreements", "Agreements", "Accepted offers become agreements. Review and e-sign them here; the funds are released once everything is signed."),
    nav("nav-support", "Support", "Raise a query, complaint or grievance and follow it by ticket. Disputes on an invoice also start here.", true),
    nav("nav-apps", "Apps", "Your company runs on apps. As the owner you can switch them on or off here, and follow upcoming modules.", true),
    nav("nav-team", "Team", "Create logins for your managers and members. You set the first password and each person replaces it at first sign-in. Managers can commit the company (accept offers, sign); members prepare work.", true),
    nav("nav-settings", "Settings", "Your profile, organisation details, security and notification preferences."),
    ...shared("customer"),
    { id: "done", title: "You are all set", body: "Start by completing verification, then add your first buyer. The dashboard will show what to do next at every stage.", cta: { label: "Go to verification", href: "/onboarding" }, nextLabel: "Finish" },
  ];

  if (role === "buyer") return [
    welcome(first, "Your suppliers use Marichi to get paid early on invoices you owe them. Your part is quick and keeps your payment terms unchanged.", [
      "Verify your business with GSTIN and PAN", "A supplier links you and uploads an invoice", "You confirm it is valid or raise a dispute", "You pay on the original due date, to the account shown for that invoice",
    ]),
    workspace("This panel shows which account you are in and your verification status."),
    nav("nav-dashboard", "Dashboard", "Invoices waiting for your confirmation, payments coming due, and how much each supplier is financing."),
    { id: "kpis", target: "kpis", optional: true, title: "Your numbers", body: "Awaiting confirmation and due in 30 days are the two to watch. Overdue payments are highlighted." },
    nav("nav-invoices", "Invoices", "Confirm or dispute each invoice. Confirming states that the invoice is valid and will be paid to Marichi's collection account on the due date."),
    nav("nav-support", "Support", "Raise a query or a complaint, and follow it by ticket.", true),
    nav("nav-apps", "Apps", "Your company runs on apps. As the owner you can switch them on or off here, and follow upcoming modules.", true),
    nav("nav-team", "Team", "Create logins for your managers and members. You set the first password and each person replaces it at first sign-in. Managers can commit the company (accept offers, sign); members prepare work.", true),
    nav("nav-settings", "Settings", "Your profile, organisation details, security and notification preferences."),
    ...shared("customer"),
    { id: "done", title: "You are all set", body: "Complete verification once, and confirmations will appear on your dashboard as suppliers upload invoices.", cta: { label: "Go to verification", href: "/onboarding" }, nextLabel: "Finish" },
  ];

  if (role === "financier") return [
    welcome(first, "The financier portal is being built. Your account is ready and you will be notified as capabilities open up.", ["Financier portal: deal flow and portfolio", "Co-lending and capital limits", "Settlement statements and reporting"]),
    workspace("This panel shows your account and workspace."),
    nav("nav-dashboard", "Dashboard", "Your home screen. It will carry deal flow and portfolio views once the portal launches."),
    nav("nav-support", "Support", "Raise a query and follow it by ticket.", true),
    nav("nav-apps", "Apps", "Your company runs on apps. As the owner you can switch them on or off here, and follow upcoming modules.", true),
    nav("nav-team", "Team", "Create logins for your managers and members. You set the first password and each person replaces it at first sign-in. Managers can commit the company (accept offers, sign); members prepare work.", true),
    nav("nav-settings", "Settings", "Your profile, security and notification preferences."),
    ...shared("customer"),
    { id: "done", title: "You are all set", body: "Open the coming-soon pages in the menu to see what is planned for financiers.", nextLabel: "Finish" },
  ];

  // ops / compliance / admin
  return [
    welcome(first, "This console is where the daily work happens: reviews, approvals, payouts, collections and risk.", [
      "Each queue shows how many items are waiting", "Maker-checker applies to large payouts", "Every change is written to the audit log", "The ledger must balance and reconcile before money moves",
    ]),
    workspace("Your role decides which screens and actions are available. Actions that move money or change a person's access are always audited."),
    nav("nav-dashboard", "Overview", "Funded volume, book health, turnaround and every work queue with live counts."),
    { id: "queues", target: "queues", optional: true, title: "Work queues", body: "Counts turn red when something is overdue or failing. Each row opens that queue." },
    nav("nav-kyb", "KYB review", "Businesses waiting for verification, including sanctions or AML hits that need a decision."),
    nav("nav-underwriting", "Underwriting", "Invoices referred for manual review, with the grade and reasons behind the system's decision."),
    nav("nav-disbursements", "Disbursements", "Fund escrow, approve large payouts (a second person must approve above the threshold), and retry failed ones."),
    nav("nav-collections", "Collections", "Buyer payments, unmatched bank credits and overdue follow-up."),
    nav("nav-fraud", "Fraud cases", "Open cases freeze the invoice until a reviewer clears it or confirms fraud."),
    nav("nav-ledger", "Ledger", "Trial balance, revenue and the daily reconciliation against the bank statement."),
    nav("nav-support", "Support queue", "Customer tickets with response and resolution timers and escalation levels."),
    nav("nav-users", "Users and roles", "Administrators can change staff roles here.", true),
    nav("nav-audit", "Audit log", "Who changed what and when, searchable by entity and action.", true),
    nav("nav-system", "System and policy", "Worker health, provider call metrics and the current policy values.", true),
    ...shared("staff"),
    { id: "done", title: "You are all set", body: "Start from the Overview and work the queues from the top. Replay this tour any time from the Help menu.", nextLabel: "Finish" },
  ];
}
