import type { Channel } from "../integrations/gateway";

// Message registry (Module 13). One entry per event. `critical` messages ignore opt-outs and go on every channel the user has
// (PRD 12.11: critical notices on at least two channels). `sms` text must match the DLT-registered template exactly in India
// (TRAI), so the wording below is what gets registered. dltTemplateId values are placeholders until the sender is registered.
// Merge fields are `{{name}}`; every field must be listed in `fields` (checked by a unit test).
export type Template = {
  fields: string[];
  critical?: boolean;
  email: { subject: string; body: string };
  sms?: { text: string; dltTemplateId: string };
};

const DLT = "DLT-PENDING-REGISTRATION";

export const TEMPLATES: Record<string, Template> = {
  // --- onboarding ---
  kyb_decision: { fields: ["status", "note"], email: { subject: "Your Marichi Labs verification: {{status}}", body: "Your business verification status is now: {{status}}.\n{{note}}" } },

  // --- invoice confirmation (buyer) ---
  confirmation_requested: { fields: ["invoiceNumber", "amount", "link"], email: { subject: "Please confirm invoice {{invoiceNumber}}", body: "A supplier has submitted invoice {{invoiceNumber}} for {{amount}} against you.\n\nOpen this link to confirm it, dispute it or ask a question. You do not need an account; we will send a one-time code to this email address first:\n{{link}}" } },
  confirmation_reminder: { fields: ["invoiceNumber", "amount", "link"], email: { subject: "Reminder: confirm invoice {{invoiceNumber}}", body: "Invoice {{invoiceNumber}} for {{amount}} is still awaiting your confirmation:\n{{link}}" } },
  confirmation_code: { fields: ["code", "minutes", "invoiceNumber"], email: { subject: "Your code for invoice {{invoiceNumber}}: {{code}}", body: "Your one-time code is {{code}}. It works for {{minutes}} minutes. Enter it on the confirmation page for invoice {{invoiceNumber}}.\n\nIf you did not ask for this, ignore this email." } },
  confirmation_undeliverable: { fields: ["invoiceNumber"], email: { subject: "No one to ask: invoice {{invoiceNumber}}", body: "Invoice {{invoiceNumber}} is waiting for buyer confirmation but the buyer has no user and no contact email on file. Ask the supplier for a contact." } },
  confirmation_escalated: { fields: ["invoiceNumber", "amount"], critical: true, email: { subject: "Invoice {{invoiceNumber}} is awaiting buyer confirmation", body: "Your buyer has not responded to invoice {{invoiceNumber}} ({{amount}}) within 72 hours. We have escalated this to our relationship team." }, sms: { text: "Marichi: your buyer has not confirmed invoice {{invoiceNumber}} in 72 hours. We have escalated it.", dltTemplateId: DLT } },
  confirmation_escalated_rm: { fields: ["invoiceNumber", "amount"], email: { subject: "Escalation: invoice {{invoiceNumber}} unconfirmed 72h", body: "Invoice {{invoiceNumber}} ({{amount}}) has had no buyer response for 72 hours." } },

  // --- invoice outcomes (seller) ---
  invoice_confirmed: { fields: ["invoiceNumber", "amount", "note"], email: { subject: "Invoice {{invoiceNumber}} confirmed by your buyer", body: "Your buyer confirmed invoice {{invoiceNumber}} ({{amount}}). We are preparing your offer." } },
  invoice_disputed: { fields: ["invoiceNumber", "amount", "note"], critical: true, email: { subject: "Invoice {{invoiceNumber}} was disputed", body: "Your buyer disputed invoice {{invoiceNumber}} ({{amount}}).\nReason: {{note}}\nFinancing is paused until this is resolved." }, sms: { text: "Marichi: invoice {{invoiceNumber}} was disputed by your buyer. Financing is paused. Please log in.", dltTemplateId: DLT } },
  invoice_clarification_requested: { fields: ["invoiceNumber", "amount", "note"], email: { subject: "Your buyer has a question on invoice {{invoiceNumber}}", body: "Question from your buyer on invoice {{invoiceNumber}}: {{note}}" } },
  invoice_deemed_accepted: { fields: ["invoiceNumber", "amount"], email: { subject: "Invoice {{invoiceNumber}} deemed accepted", body: "Invoice {{invoiceNumber}} ({{amount}}) is deemed accepted as the buyer did not respond within the agreed window." } },

  // --- offers & agreements ---
  offer_ready: { fields: ["invoiceNumber", "advance", "expires"], email: { subject: "Financing offer ready for invoice {{invoiceNumber}}", body: "You have an advance offer of {{advance}} for invoice {{invoiceNumber}}. It is valid until {{expires}}." } },
  bid_received: { fields: ["invoiceNumber", "advance"], email: { subject: "New bid on invoice {{invoiceNumber}}", body: "A financier has bid {{advance}} on invoice {{invoiceNumber}}. Compare the bids and choose one in your Invoices page." } },
  bid_accepted: { fields: ["invoiceNumber", "advance"], email: { subject: "Your bid on invoice {{invoiceNumber}} was accepted", body: "The seller accepted your bid of {{advance}} on invoice {{invoiceNumber}}. The advance is paid out once the agreements are signed." } },
  early_payment_proposed: { fields: ["invoiceNumber", "buyer", "net", "discount"], email: { subject: "{{buyer}} offers to pay invoice {{invoiceNumber}} early", body: "{{buyer}} offers to pay invoice {{invoiceNumber}} now: you would receive {{net}} before fees, a discount of {{discount}}. Open Invoices to accept or decline." } },
  early_payment_accepted: { fields: ["invoiceNumber", "net", "account", "ifsc", "by"], email: { subject: "Early payment accepted: pay {{net}} for invoice {{invoiceNumber}}", body: "Your supplier accepted early payment of invoice {{invoiceNumber}}. Pay exactly {{net}} to account {{account}} ({{ifsc}}) by {{by}}. The early payment lapses after that." } },
  early_payment_declined: { fields: ["invoiceNumber"], email: { subject: "Early payment declined: invoice {{invoiceNumber}}", body: "Your supplier declined early payment of invoice {{invoiceNumber}}. It stays payable on the due date." } },
  programme_invite: { fields: ["buyer", "rate", "name"], email: { subject: "{{buyer}} invites you to its supplier finance programme", body: "{{buyer}} has invited you to join {{name}}. Invoices you raise on {{buyer}} are financed at {{rate}}% a year, priced on their credit. Open Buyers to accept or decline." } },
  programme_decision: { fields: ["name", "status", "note"], email: { subject: "Your supplier finance programme: {{status}}", body: "Your programme {{name}} is now: {{status}}.\n{{note}}" } },
  report_ready: { fields: ["report", "link"], email: { subject: "Your {{report}} report is ready", body: "Your scheduled {{report}} report has been built. Download it here:\n{{link}}" } },
  team_invite: { fields: ["company", "role", "inviter", "link", "days"], email: { subject: "{{inviter}} invited you to {{company}} on Marichi", body: "{{inviter}} invited you to join {{company}} on Marichi as {{role}}.\n\nOpen this link to accept. You will choose your own password and set up two-step verification. The link works once and expires in {{days}} days:\n{{link}}\n\nIf you were not expecting this, ignore this email and nothing happens." } },
  staff_invite: { fields: ["role", "inviter", "link", "days"], email: { subject: "{{inviter}} invited you to the Marichi Labs team", body: "{{inviter}} invited you to join the Marichi Labs operations team as {{role}}.\n\nOpen this link to accept. You will choose your own password and set up two-step verification. The link works once and expires in {{days}} days:\n{{link}}\n\nIf you were not expecting this, ignore this email and nothing happens." } },
  kyb_rekyc_soon: { fields: ["date"], email: { subject: "Your verification is due on {{date}}", body: "Your business verification is due for renewal on {{date}}. Open Verification and confirm your details before then, so your financing is not interrupted." } },
  kyb_rekyc_due: { fields: ["date"], email: { subject: "Please verify your business again", body: "Your business verification needs to be confirmed again. New financing is paused until you do. Open Verification and check your details." } },
  licence_expiring: { fields: ["days", "date"], email: { subject: "Your licence expires in {{days}} days", body: "The licence on your financier application runs out on {{date}} ({{days}} days). Bidding and funding stop on that date. Send your renewed licence under Application so it can be checked." } },
  financed_invoice_flagged: { fields: ["invoiceNumber", "reason"], critical: true, email: { subject: "Invoice {{invoiceNumber}} has been flagged", body: "A check after funding found a problem with invoice {{invoiceNumber}}: {{reason}}. It is under review by our compliance team and we will tell you the outcome." } },
  approval_requested: { fields: ["summary", "by", "link"], email: { subject: "Approval needed: {{summary}}", body: "{{by}} asked for your approval: {{summary}}\n\nReview it here:\n{{link}}" } },
  approval_decided: { fields: ["summary", "outcome", "note"], email: { subject: "Your request was {{outcome}}: {{summary}}", body: "Your request ({{summary}}) was {{outcome}}.\n{{note}}" } },
  financier_application: { fields: ["name", "licence", "link"], email: { subject: "Financier application to review: {{name}}", body: "{{name}} sent a financier application (licence {{licence}}). Review it here:\n{{link}}" } },
  financier_decision: { fields: ["status", "note"], email: { subject: "Your financier application: {{status}}", body: "Your financier application is now: {{status}}.\n{{note}}" } },
  invoice_unfunded: { fields: ["invoiceNumber"], email: { subject: "Invoice {{invoiceNumber}} cannot be funded right now", body: "We could not fund invoice {{invoiceNumber}} at this time. We will retry when capacity is available." } },
  assignment_notice: { fields: ["invoiceNumber", "link"], critical: true, email: { subject: "Notice of assignment: invoice {{invoiceNumber}}", body: "Invoice {{invoiceNumber}} has been assigned to Marichi Labs. Payment must be made only to the account in this notice:\n{{link}}" }, sms: { text: "Marichi: invoice {{invoiceNumber}} has been assigned to Marichi Labs. Pay only to the account in the notice emailed to you.", dltTemplateId: DLT } },

  // --- money out ---
  disbursed: { fields: ["invoiceNumber", "amount"], critical: true, email: { subject: "{{amount}} paid out for invoice {{invoiceNumber}}", body: "We have paid {{amount}} to your verified bank account against invoice {{invoiceNumber}}." }, sms: { text: "Marichi: {{amount}} has been paid to your bank account for invoice {{invoiceNumber}}.", dltTemplateId: DLT } },
  surplus_paid: { fields: ["amount"], critical: true, email: { subject: "Balance of {{amount}} paid to you", body: "The invoice balance of {{amount}} has been paid to your verified bank account." }, sms: { text: "Marichi: the balance of {{amount}} has been paid to your bank account.", dltTemplateId: DLT } },

  // --- collections ---
  payment_reminder_pre_due: { fields: ["invoiceNumber", "due", "amount"], email: { subject: "Payment due soon: invoice {{invoiceNumber}}", body: "Invoice {{invoiceNumber}} ({{amount}}) is due on {{due}}. Please pay to the collection account in the assignment notice." } },
  payment_due_today: { fields: ["invoiceNumber", "due", "amount"], critical: true, email: { subject: "Payment due today: invoice {{invoiceNumber}}", body: "Invoice {{invoiceNumber}} ({{amount}}) is due today ({{due}})." }, sms: { text: "Marichi: invoice {{invoiceNumber}} for {{amount}} is due today. Please pay to the collection account.", dltTemplateId: DLT } },
  payment_overdue: { fields: ["invoiceNumber", "due", "amount"], critical: true, email: { subject: "OVERDUE: invoice {{invoiceNumber}}", body: "Invoice {{invoiceNumber}} ({{amount}}) was due on {{due}} and is overdue. Late charges apply." }, sms: { text: "Marichi: invoice {{invoiceNumber}} for {{amount}} is overdue. Late charges apply. Please pay now.", dltTemplateId: DLT } },
  recourse_notice: { fields: ["invoiceNumber", "due", "amount", "dpd"], critical: true, email: { subject: "Recourse notice: invoice {{invoiceNumber}}", body: "Your buyer has not paid invoice {{invoiceNumber}} ({{amount}}), {{dpd}} days past due. Under your agreement you are now liable for the outstanding amount." }, sms: { text: "Marichi: buyer has not paid invoice {{invoiceNumber}}. You are now liable for the outstanding amount. Please log in.", dltTemplateId: DLT } },
  payment_received: { fields: ["invoiceNumber", "amount"], email: { subject: "Payment of {{amount}} received for invoice {{invoiceNumber}}", body: "We received {{amount}} against invoice {{invoiceNumber}}. Thank you." } },
  payment_received_partial: { fields: ["invoiceNumber", "amount"], email: { subject: "Part-payment of {{amount}} received: invoice {{invoiceNumber}}", body: "We received a part-payment of {{amount}} against invoice {{invoiceNumber}}. A balance remains." } },
  invoice_settled: { fields: ["invoiceNumber", "amount"], email: { subject: "Invoice {{invoiceNumber}} fully settled", body: "Invoice {{invoiceNumber}} is fully paid. Any balance due to you will be paid out." } },

  // --- support & disputes (Module 16) ---
  ticket_opened: { fields: ["ticketNo", "subject", "due"], email: { subject: "We received your request {{ticketNo}}", body: "Your request \"{{subject}}\" is logged as {{ticketNo}}. We will respond by {{due}}." } },
  grievance_ack: { fields: ["ticketNo", "due", "officer", "officerEmail", "officerPhone"], email: { subject: "Grievance {{ticketNo}} registered", body: "We have registered your grievance as {{ticketNo}} and will resolve it by {{due}}.\nGrievance officer: {{officer}}, {{officerEmail}}, {{officerPhone}}.\nIf it is not resolved in time, you may approach the Ombudsman; details are on our grievance page." } },
  ticket_reply: { fields: ["ticketNo", "subject"], email: { subject: "New reply on {{ticketNo}}", body: "There is a new reply on {{ticketNo}} ({{subject}}). Log in to read and respond." } },
  ticket_resolved: { fields: ["ticketNo", "subject", "note"], email: { subject: "{{ticketNo}} resolved", body: "{{ticketNo}} ({{subject}}) was marked resolved.\n{{note}}\nIf you are not satisfied you can reopen it within 7 days." } },
  dispute_resolved: { fields: ["ticketNo", "invoiceNumber", "outcome", "note"], critical: true, email: { subject: "Dispute on invoice {{invoiceNumber}} resolved: {{outcome}}", body: "The dispute on invoice {{invoiceNumber}} ({{ticketNo}}) is resolved: {{outcome}}.\n{{note}}" }, sms: { text: "Marichi: the dispute on invoice {{invoiceNumber}} is resolved: {{outcome}}. Please log in for details.", dltTemplateId: DLT } },
  clawback_notice: { fields: ["invoiceNumber", "amount"], critical: true, email: { subject: "Repayment required: invoice {{invoiceNumber}} was cancelled", body: "Invoice {{invoiceNumber}} was found invalid following a dispute. Under your agreement you must repay the financed amount ({{amount}} invoice value). Our collections team will contact you." }, sms: { text: "Marichi: invoice {{invoiceNumber}} was cancelled after a dispute. You must repay the financed amount. Please log in.", dltTemplateId: DLT } },
  credit_note_issued: { fields: ["invoiceNumber", "creditNote", "amount", "newAmount", "reason"], critical: true, email: { subject: "Credit note {{creditNote}} on invoice {{invoiceNumber}}", body: "Credit note {{creditNote}} for {{amount}} was issued on invoice {{invoiceNumber}}. Reason: {{reason}}\nThe invoice is now {{newAmount}}." } },
  credit_note_shortfall: { fields: ["invoiceNumber", "amount"], critical: true, email: { subject: "Credit note on invoice {{invoiceNumber}}", body: "A credit note of {{amount}} was agreed on invoice {{invoiceNumber}}. Your buyer will pay that much less; you are responsible for the shortfall under your agreement." }, sms: { text: "Marichi: a credit note of {{amount}} was agreed on invoice {{invoiceNumber}}. You are responsible for the shortfall.", dltTemplateId: DLT } },

  // --- NACH auto-debit ---
  mandate_active: { fields: ["account"], email: { subject: "Auto-pay is on", body: "Your bank has authorised auto-pay from account {{account}}. Invoices financed through Marichi will be debited on their due date, and you will get a notice the day before." } },
  mandate_rejected: { fields: ["reason"], email: { subject: "Auto-pay was not authorised", body: "Your bank did not authorise the auto-pay mandate: {{reason}}. You can set it up again, or keep paying invoices manually." } },
  nach_pre_debit: { fields: ["invoiceNumber", "amount", "due"], critical: true, email: { subject: "Auto-debit tomorrow: invoice {{invoiceNumber}}", body: "{{amount}} will be debited from your account tomorrow ({{due}}) for invoice {{invoiceNumber}}, under your auto-pay mandate. Make sure the funds are available." }, sms: { text: "Marichi: {{amount}} will be auto-debited tomorrow for invoice {{invoiceNumber}}. Keep funds available.", dltTemplateId: DLT } },
  nach_debit_failed: { fields: ["invoiceNumber", "amount", "reason"], critical: true, email: { subject: "Auto-debit failed: invoice {{invoiceNumber}}", body: "We could not debit {{amount}} for invoice {{invoiceNumber}}: {{reason}}. We will try again, or you can pay to the collection account shown on the invoice." }, sms: { text: "Marichi: auto-debit of {{amount}} for invoice {{invoiceNumber}} failed ({{reason}}). Please pay manually.", dltTemplateId: DLT } },
  nach_over_limit: { fields: ["invoiceNumber", "amount", "limit"], critical: true, email: { subject: "Auto-debit skipped: invoice {{invoiceNumber}}", body: "Invoice {{invoiceNumber}} is for {{amount}}, above your auto-pay limit of {{limit}}, so it was not debited. Please pay it manually or raise the limit." } },

  // --- internal (staff) ---
  ticket_staff_new: { fields: ["ticketNo", "kind", "subject"], email: { subject: "New {{kind}}: {{ticketNo}}", body: "{{ticketNo}} ({{kind}}): {{subject}}" } },
  ticket_escalated: { fields: ["ticketNo", "kind", "subject", "level", "reason"], email: { subject: "Escalated to level {{level}}: {{ticketNo}}", body: "{{ticketNo}} ({{kind}}, {{subject}}) was escalated to level {{level}}: {{reason}}" } },
  ombudsman_escalated: { fields: ["ticketNo", "subject"], email: { subject: "Customer escalated {{ticketNo}} to the Ombudsman", body: "{{ticketNo}} ({{subject}}) was escalated to the Ombudsman by the customer. Compliance must prepare the response." } },
  disbursement_needs_attention: { fields: ["disbursementId", "reason"], email: { subject: "Payout needs attention", body: "Disbursement {{disbursementId}} failed after automatic retries: {{reason}}" } },
  collections_escalation: { fields: ["invoiceNumber", "due", "amount", "dpd"], email: { subject: "Collections: {{invoiceNumber}} is {{dpd}} days overdue", body: "Invoice {{invoiceNumber}} ({{amount}}), due {{due}}, is {{dpd}} days past due." } },
  write_off_review: { fields: ["invoiceNumber", "due", "amount", "dpd"], email: { subject: "NPA: {{invoiceNumber}} is {{dpd}} days overdue", body: "Invoice {{invoiceNumber}} ({{amount}}) is past 90 days: review for write-off." } },
  registry_attention: { fields: ["registry", "offer", "reason"], email: { subject: "Registry filing needs attention ({{registry}})", body: "The assignment for offer {{offer}} could not be filed at {{registry}} after several tries: {{reason}}. The payout waits where the country requires filing first." } },
  unmatched_credit: { fields: ["utr", "reason"], email: { subject: "Unmatched bank credit {{utr}}", body: "A bank credit could not be matched: {{reason}}. UTR {{utr}}." } },
  reconciliation_variance: { fields: ["date", "variance", "exceptions"], email: { subject: "Reconciliation variance for {{date}}", body: "Escrow reconciliation for {{date}} did not tie out. Variance {{variance}} paise, {{exceptions}} exception(s)." } },
  fraud_case_opened: { fields: ["caseId", "rule", "severity"], email: { subject: "New {{severity}} fraud case: {{rule}}", body: "Case {{caseId}} ({{rule}}, {{severity}}) was opened and is awaiting review." } },
};

/** Fixed OTP wording (not in the registry: the code must never be stored in the notifications log). */
export const OTP_SMS = { text: "Marichi: {{code}} is your verification code. It expires in 10 minutes. Do not share it.", dltTemplateId: DLT };

const fill = (s: string, data: Record<string, string>, escape: boolean) =>
  s.replace(/\{\{(\w+)\}\}/g, (_, k: string) => (escape ? String(data[k] ?? "").replace(/[\r\n]+/g, " ") : String(data[k] ?? "")));

export const placeholders = (s: string) => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);

/**
 * Render one channel. Values are user-controlled (invoice numbers, notes): newlines are flattened in the subject and SMS
 * so a value can't inject extra headers or forge message lines. Email body is plain text (no HTML to escape).
 */
export function render(template: string, channel: Channel, data: Record<string, string>) {
  const t = TEMPLATES[template];
  if (!t) throw new Error(`unknown notification template: ${template}`);
  if (channel === "sms") {
    if (!t.sms) return null;
    // "₹" isn't in the GSM-7 alphabet: one such character would switch the whole SMS to UCS-2 (70 chars/segment, more cost).
    return { body: fill(t.sms.text, data, true).replaceAll("₹", "Rs."), dltTemplateId: t.sms.dltTemplateId };
  }
  const flat = (s: string) => fill(s, data, true);
  return { subject: flat(t.email.subject), body: t.email.body.replace(/\{\{(\w+)\}\}/g, (_, k: string) => String(data[k] ?? "")) };
}
