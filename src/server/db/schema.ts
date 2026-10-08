import { sql } from "drizzle-orm";
import { customType } from "drizzle-orm/pg-core";
import { decrypt, encrypt } from "../crypto";
import {
  pgTable, pgEnum, uuid, text, timestamp, bigint, integer, boolean, jsonb, date, numeric, uniqueIndex, index,
} from "drizzle-orm/pg-core";

// Sensitive text stored encrypted (AES-256-GCM): code reads and writes plain values, the database only ever sees ciphertext.
const encrypted = customType<{ data: string; driverData: string }>({
  dataType: () => "text",
  toDriver: (v) => encrypt(v),
  fromDriver: (v) => decrypt(v),
});

// Money is ALWAYS integer paise (bigint). Never floats.
const paise = (name: string) => bigint(name, { mode: "bigint" });
const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const role = pgEnum("role", ["seller", "buyer", "financier", "admin", "ops", "compliance"]);
export const orgRole = pgEnum("org_role", ["owner", "manager", "member"]); // a person's level inside their company
export const kycStatus = pgEnum("kyc_status", [
  "draft", "submitted", "under_review", "info_requested", "approved", "rejected", "rekyc_due",
]);
export const invoiceStatus = pgEnum("invoice_status", [
  "uploaded", "validated", "sent_for_confirmation", "confirmed", "disputed", "eligible",
  "financed", "due", "paid", "overdue", "written_off", "rejected", // rejected = confirmed fraud before funding
]);
// light = buyers (they receive no funds); full = sellers/financiers and SCF-sponsoring buyers.
export const kybLevel = pgEnum("kyb_level", ["light", "full"]);
export const offerStatus = pgEnum("offer_status", ["open", "accepted", "expired", "rejected"]);
export const payStatus = pgEnum("pay_status", ["pending", "processing", "succeeded", "failed"]);
export const direction = pgEnum("direction", ["debit", "credit"]);

// ---- Module 1 / 2 ----
export const businesses = pgTable("businesses", {
  id: id(),
  legalName: text("legal_name").notNull(),
  entityType: text("entity_type").notNull(),
  gstin: text("gstin").unique(),
  pan: encrypted("pan"), // encrypted at rest
  cin: text("cin"),
  kybStatus: kycStatus("kyb_status").notNull().default("draft"),
  kybNote: text("kyb_note"),
  kybLevel: kybLevel("kyb_level").notNull().default("full"),
  creditLimit: paise("credit_limit").notNull().default(sql`0`),
  // Company workspace (Odoo-style onboarding): what the owner chose to switch on, and how the workspace is branded.
  displayName: text("display_name"), // shown in the sidebar and headings; falls back to legalName
  logoRef: text("logo_ref"), // vault reference of the company picture
  apps: text("apps").array().notNull().default(sql`'{}'::text[]`), // enabled app ids (see src/lib/apps.ts)
  setupCompletedAt: timestamp("setup_completed_at", { withTimezone: true }), // null = the owner still has to run the setup wizard
  phone: text("phone"),
  city: text("city"),
  industry: text("industry"),
  country: text("country"), // ISO-3166 alpha-2; null means India
  taxId: text("tax_id"), // an overseas company's tax or registration number (no GSTIN)
  createdAt: createdAt(),
});

// The scoring model's verdict on each underwriting decision, kept next to the rules' verdict for comparison.
export const mlScores = pgTable("ml_scores", {
  invoiceId: uuid("invoice_id").primaryKey().references(() => invoices.id),
  version: text("version").notNull(),
  pd: numeric("pd", { precision: 8, scale: 6 }).notNull(),
  grade: text("grade").notNull(),
  rulesGrade: text("rules_grade").notNull(),
  rulesDecision: text("rules_decision").notNull(),
  finalDecision: text("final_decision").notNull(), // what actually happened (differs from rulesDecision only in assist mode)
  reasons: jsonb("reasons").notNull(),
  features: jsonb("features").notNull(),
  createdAt: createdAt(),
});

// Admin-editable policy values (Module 15). One row per overridden key; a missing row means "use the code default".
export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  version: integer("version").notNull().default(1),
  updatedBy: uuid("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export const settingsHistory = pgTable("settings_history", {
  id: id(),
  key: text("key").notNull(),
  version: integer("version").notNull(),
  before: jsonb("before"),
  after: jsonb("after"), // null = reset to default
  note: text("note").notNull(),
  changedBy: uuid("changed_by"),
  createdAt: createdAt(),
}, (t) => [index("settings_history_key").on(t.key, t.createdAt)]);

// Better Auth tables (user/session/account/verification/twoFactor): column keys must match its field names.
// `role` and `businessId` are server-controlled (see auth.ts, input:false).
export const users = pgTable("users", {
  id: id(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  twoFactorEnabled: boolean("two_factor_enabled").default(false),
  phone: text("phone"), // E.164. SMS is sent only once phoneVerified (an unverified number could belong to someone else)
  phoneVerified: boolean("phone_verified").notNull().default(false),
  role: role("role").notNull().default("seller"),
  businessId: uuid("business_id").references(() => businesses.id),
  kycStatus: kycStatus("kyc_status").notNull().default("draft"),
  tourSeenAt: timestamp("tour_seen_at", { withTimezone: true }), // null = show the guided product tour on next visit
  orgRole: orgRole("org_role"), // owner | manager | member inside the company; null for platform staff
  mustChangePassword: boolean("must_change_password").notNull().default(false), // set when the owner issued the password
  suspendedAt: timestamp("suspended_at", { withTimezone: true }), // set = cannot sign in or use any page
  invitedBy: uuid("invited_by"), // the owner who created this account
});

const ts = (n: string) => timestamp(n, { withTimezone: true });
export const session = pgTable("session", {
  id: id(),
  expiresAt: ts("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().defaultNow().$onUpdate(() => new Date()),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
}, (t) => [index("session_user").on(t.userId)]);

export const account = pgTable("account", {
  id: id(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: ts("access_token_expires_at"),
  refreshTokenExpiresAt: ts("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => [index("account_user").on(t.userId)]);

export const verification = pgTable("verification", {
  id: id(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: ts("expires_at").notNull(),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => [index("verification_identifier").on(t.identifier)]);

export const twoFactor = pgTable("two_factor", {
  id: id(),
  secret: text("secret").notNull(),
  backupCodes: text("backup_codes").notNull(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  verified: boolean("verified").default(true),
  failedVerificationCount: integer("failed_verification_count").default(0),
  lockedUntil: ts("locked_until"),
}, (t) => [index("two_factor_user").on(t.userId)]);

// ---- Module 1: KYB detail ----
export const businessBankAccounts = pgTable("business_bank_accounts", {
  id: id(),
  businessId: uuid("business_id").notNull().references(() => businesses.id),
  accountNumber: encrypted("account_number").notNull(), // encrypted at rest; mask in UI and logs
  ifsc: text("ifsc").notNull(),
  holderName: text("holder_name").notNull(),
  verified: boolean("verified").notNull().default(false),
  nameMatch: boolean("name_match"),
  createdAt: createdAt(),
});

export const ubos = pgTable("ubos", {
  id: id(),
  businessId: uuid("business_id").notNull().references(() => businesses.id),
  name: text("name").notNull(),
  din: text("din"),
  shareholdingBps: integer("shareholding_bps").notNull(),
  pepFlag: boolean("pep_flag").notNull().default(false),
  screeningScore: integer("screening_score"),
  screeningHit: boolean("screening_hit"),
  createdAt: createdAt(),
});

export const buyerSellerRelationships = pgTable("buyer_seller_relationships", {
  id: id(),
  buyerId: uuid("buyer_id").notNull().references(() => businesses.id),
  sellerId: uuid("seller_id").notNull().references(() => businesses.id),
  programId: uuid("program_id"),
  creditTermsDays: integer("credit_terms_days").notNull().default(60),
  maxExposure: paise("max_exposure"), // per-seller cap on this buyer; enforced at underwriting (Module 5). null = no cap
  deemedAcceptanceDays: integer("deemed_acceptance_days"), // Module 4 optional rule from the buyer agreement; null = off
  createdAt: createdAt(),
}, (t) => [uniqueIndex("bsr_pair").on(t.buyerId, t.sellerId)]);

// "Invite your buyer" flow: seller names a buyer who isn't verified yet. Resolved when that buyer is approved.
export const buyerInvites = pgTable("buyer_invites", {
  id: id(),
  sellerId: uuid("seller_id").notNull().references(() => businesses.id),
  buyerGstin: text("buyer_gstin").notNull(),
  buyerEmail: text("buyer_email").notNull(),
  creditTermsDays: integer("credit_terms_days").notNull().default(60),
  status: text("status").notNull().default("pending"), // pending | linked
  createdAt: createdAt(),
}, (t) => [uniqueIndex("invite_pair").on(t.sellerId, t.buyerGstin)]);

// ---- Module 3 / 4 ----
export const invoices = pgTable("invoices", {
  id: id(),
  sellerId: uuid("seller_id").notNull().references(() => businesses.id),
  buyerId: uuid("buyer_id").notNull().references(() => businesses.id),
  invoiceNumber: text("invoice_number").notNull(),
  invoiceDate: date("invoice_date").notNull(),
  dueDate: date("due_date").notNull(),
  amount: paise("amount").notNull(),
  taxBreakup: jsonb("tax_breakup"),
  lineItems: jsonb("line_items"),
  poReference: text("po_reference"),
  irn: text("irn"),
  contentHash: text("content_hash").notNull(),
  source: text("source").notNull().default("upload"), // upload | api | csv: how the invoice reached us
  // Export invoices: `amount` is always rupees (the locked conversion), so the rest of the platform needs no change.
  currency: text("currency").notNull().default("INR"),
  foreignAmount: paise("foreign_amount"), // minor units (cents) of `currency`, when it is not INR
  fxRateMicro: paise("fx_rate_micro"), // locked rupees per unit x 1e6, after the safety buffer
  shippingBill: text("shipping_bill"), // goods exports
  purposeCode: text("purpose_code"), // RBI purpose-of-remittance code, services exports
  documentRef: text("document_ref"), // vault reference to the uploaded PDF/image
  // absent = no IRN supplied (compensating controls apply); pending = IRP down, auto-retried
  irnStatus: text("irn_status").notNull().default("absent"), // absent | verified | mismatch | pending
  reviewNote: text("review_note"),
  status: invoiceStatus("status").notNull().default("uploaded"),
  disputeFlag: boolean("dispute_flag").notNull().default(false),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  // Double-financing defence: same IRN or same file hash can exist only once.
  uniqueIndex("inv_irn_uniq").on(t.irn),
  uniqueIndex("inv_hash_uniq").on(t.contentHash),
  uniqueIndex("inv_seller_no").on(t.sellerId, t.invoiceNumber),
  index("inv_status").on(t.status),
]);

// One confirmation request per invoice; the row doubles as the legal audit trail (who/when/where).
export const invoiceConfirmations = pgTable("invoice_confirmations", {
  id: id(),
  invoiceId: uuid("invoice_id").notNull().references(() => invoices.id),
  status: text("status").notNull().default("pending"), // pending | clarification | confirmed | disputed
  method: text("method"), // buyer | deemed
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
  respondedAt: timestamp("responded_at", { withTimezone: true }),
  respondedBy: uuid("responded_by"),
  respondedByEmail: text("responded_by_email"),
  ip: text("ip"),
  userAgent: text("user_agent"),
  note: text("note"),
  reminder24At: timestamp("reminder_24_at", { withTimezone: true }),
  reminder48At: timestamp("reminder_48_at", { withTimezone: true }),
  escalatedAt: timestamp("escalated_at", { withTimezone: true }),
}, (t) => [uniqueIndex("conf_invoice").on(t.invoiceId)]);

// ---- Module 5 / 6 / 7 ----
export const underwritingDecisions = pgTable("underwriting_decisions", {
  id: id(),
  invoiceId: uuid("invoice_id").notNull().references(() => invoices.id),
  decision: text("decision").notNull(), // approved | referred | declined
  riskGrade: text("risk_grade").notNull(), // A-E
  pd: numeric("pd", { precision: 6, scale: 4 }),
  advanceRateBps: integer("advance_rate_bps").notNull(),
  discountRateBps: integer("discount_rate_bps").notNull(), // annualised
  reasons: jsonb("reasons").notNull(), // [{code,text}] explainability / adverse-action
  inputs: jsonb("inputs").notNull(), // snapshot for audit + model backtesting
  decidedBy: text("decided_by").notNull().default("rules-v1"),
  reviewNote: text("review_note"),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("uw_invoice").on(t.invoiceId)]);

// Consent artifacts must exist before any bureau pull (PRD 12.5). Retained for the audit period.
export const consents = pgTable("consents", {
  id: id(),
  businessId: uuid("business_id").notNull().references(() => businesses.id),
  userId: uuid("user_id"),
  purpose: text("purpose").notNull(), // bureau_pull
  text: text("text").notNull(), // exact wording shown
  ip: text("ip"),
  createdAt: createdAt(),
});

export const financingOffers = pgTable("financing_offers", {
  id: id(),
  invoiceId: uuid("invoice_id").notNull().references(() => invoices.id),
  financierId: uuid("financier_id"), // null = platform balance sheet
  advanceAmount: paise("advance_amount").notNull(),
  discountBps: integer("discount_bps").notNull(),
  feeAmount: paise("fee_amount").notNull().default(sql`0`),
  tenorDays: integer("tenor_days").notNull(), // offer date -> invoice due date
  expectedDiscount: paise("expected_discount").notNull(), // accrues daily, settled from the buyer's payment (Module 9)
  recourse: boolean("recourse").notNull().default(true),
  status: offerStatus("status").notNull().default("open"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  acceptedBy: uuid("accepted_by"),
  createdAt: createdAt(),
}, (t) => [
  // At most one live offer per invoice; expired/rejected ones don't block a fresh offer.
  uniqueIndex("offer_live").on(t.invoiceId).where(sql`status in ('open','accepted')`),
]);

// Marketplace: a financier's bid to fund one invoice. Accepting a bid creates the (accepted) financing offer with that financier.
export const bids = pgTable("bids", {
  id: id(),
  invoiceId: uuid("invoice_id").notNull().references(() => invoices.id),
  financierId: uuid("financier_id").notNull().references(() => businesses.id),
  advanceAmount: paise("advance_amount").notNull(),
  discountBps: integer("discount_bps").notNull(),
  feeAmount: paise("fee_amount").notNull(),
  expectedDiscount: paise("expected_discount").notNull(),
  tenorDays: integer("tenor_days").notNull(),
  status: text("status").notNull().default("open"), // open | accepted | rejected | withdrawn | expired
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("bid_open").on(t.invoiceId, t.financierId).where(sql`status = 'open'`), // one live bid per financier per invoice
  index("bid_invoice").on(t.invoiceId),
]);

// Dynamic discounting: the buyer pays an approved invoice early from its own cash, at a discount the seller accepts.
export const earlyPayments = pgTable("early_payments", {
  id: id(),
  invoiceId: uuid("invoice_id").notNull().references(() => invoices.id),
  buyerId: uuid("buyer_id").notNull().references(() => businesses.id),
  sellerId: uuid("seller_id").notNull().references(() => businesses.id),
  discountBps: integer("discount_bps").notNull(), // annualised
  daysEarly: integer("days_early").notNull(),
  discountAmount: paise("discount_amount").notNull(), // what the buyer saves
  netAmount: paise("net_amount").notNull(), // what the buyer pays now (invoice amount less the discount)
  feeAmount: paise("fee_amount").notNull(), // platform fee deducted from the seller's payout, GST-inclusive
  status: text("status").notNull().default("proposed"), // proposed | accepted | declined | expired | paid | cancelled
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(), // while proposed: the seller's time to answer. once accepted: the buyer's time to pay
  proposedBy: uuid("proposed_by"),
  respondedBy: uuid("responded_by"),
  respondedAt: timestamp("responded_at", { withTimezone: true }),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("ep_live").on(t.invoiceId).where(sql`status in ('proposed','accepted')`),
]);

// Supply chain finance: a buyer-led programme. Staff approve the buyer with a limit and a price based on the buyer's credit;
// the buyer's suppliers who join are financed at that price instead of their own.
export const scfProgrammes = pgTable("scf_programmes", {
  id: id(),
  buyerId: uuid("buyer_id").notNull().references(() => businesses.id),
  name: text("name").notNull(),
  requestedLimit: paise("requested_limit").notNull(),
  limit: paise("limit").notNull().default(sql`0`), // approved; zero until staff approve
  discountBps: integer("discount_bps"), // yearly, set at approval
  advanceBps: integer("advance_bps"), // share of the invoice advanced, set at approval
  status: text("status").notNull().default("requested"), // requested | active | paused | declined
  decidedBy: uuid("decided_by"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  decisionNote: text("decision_note"),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("scf_buyer").on(t.buyerId).where(sql`status in ('requested','active','paused')`)]);

export const scfSuppliers = pgTable("scf_suppliers", {
  id: id(),
  programmeId: uuid("programme_id").notNull().references(() => scfProgrammes.id),
  sellerId: uuid("seller_id").notNull().references(() => businesses.id),
  status: text("status").notNull().default("invited"), // invited | active | declined | removed
  invitedAt: timestamp("invited_at", { withTimezone: true }).notNull().defaultNow(),
  respondedAt: timestamp("responded_at", { withTimezone: true }),
}, (t) => [uniqueIndex("scf_supplier").on(t.programmeId, t.sellerId)]);

// A buyer's payment in a foreign currency, as received, and what it converted to. Kept for FX reporting and export-proof paperwork.
export const foreignReceipts = pgTable("foreign_receipts", {
  id: id(),
  utr: text("utr").notNull().unique(),
  invoiceId: uuid("invoice_id").notNull().references(() => invoices.id),
  currency: text("currency").notNull(),
  foreignAmount: paise("foreign_amount").notNull(),
  rateMicro: paise("rate_micro").notNull(), // rupees per unit x 1e6 used for the conversion, after the bank spread
  inrAmount: paise("inr_amount").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

// Reports a user asked to have built on a schedule. Each run keeps its CSV so it can be downloaded later.
export const reportSchedules = pgTable("report_schedules", {
  id: id(),
  userId: uuid("user_id").notNull().references(() => users.id),
  businessId: uuid("business_id"), // null for platform staff
  role: text("role").notNull(), // the scope the report is built for
  kind: text("kind").notNull(), // forecast | vintage | concentration
  frequency: text("frequency").notNull(), // weekly | monthly
  active: boolean("active").notNull().default(true),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("rs_user_kind").on(t.userId, t.kind)]);

export const reportRuns = pgTable("report_runs", {
  id: id(),
  scheduleId: uuid("schedule_id").notNull().references(() => reportSchedules.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  kind: text("kind").notNull(),
  filename: text("filename").notNull(),
  content: text("content").notNull(), // the CSV
  createdAt: createdAt(),
}, (t) => [index("rr_user").on(t.userId, t.createdAt)]);

// master (one per seller) + invoice_schedule (per offer) are e-signed by the seller;
// assignment_notice (per offer) is sent to the buyer. Disbursement needs all three (Module 8 gate).
export const agreements = pgTable("agreements", {
  id: id(),
  businessId: uuid("business_id").notNull().references(() => businesses.id), // the seller
  offerId: uuid("offer_id").references(() => financingOffers.id), // null for the master agreement
  kind: text("kind").notNull(), // master | invoice_schedule | assignment_notice
  documentRef: text("document_ref").notNull(), // vault ref of the generated document
  documentHash: text("document_hash").notNull(), // what exactly was signed
  status: text("status").notNull().default("pending"), // pending | sent | signed | failed
  esignRequestId: text("esign_request_id"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  signedAt: timestamp("signed_at", { withTimezone: true }),
  signedBy: uuid("signed_by"),
  signedByEmail: text("signed_by_email"),
  signedIp: text("signed_ip"),
  signedUserAgent: text("signed_user_agent"),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("agr_master").on(t.businessId).where(sql`kind = 'master'`),
  uniqueIndex("agr_offer_kind").on(t.offerId, t.kind).where(sql`offer_id is not null`),
  uniqueIndex("agr_esign_req").on(t.esignRequestId),
]);

// ---- Module 8 / 9 ----
export const disbursements = pgTable("disbursements", {
  id: id(),
  offerId: uuid("offer_id").notNull().references(() => financingOffers.id),
  amount: paise("amount").notNull(), // net paid to the seller: advance - upfront fee
  bankRef: text("bank_ref"),
  status: payStatus("status").notNull().default("pending"),
  idempotencyKey: text("idempotency_key").notNull().unique(), // identifies the disbursement; each payout attempt derives `${id}:${attempts}`
  makerId: uuid("maker_id"), // null = created by the system
  needsApproval: boolean("needs_approval").notNull().default(false), // maker-checker above the threshold
  approvedBy: uuid("approved_by"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  rail: text("rail"), // IMPS | NEFT | RTGS (last used)
  attempts: integer("attempts").notNull().default(0), // payout attempts that reached a final failure
  failureReason: text("failure_reason"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("disb_offer").on(t.offerId)]);

export const repayments = pgTable("repayments", {
  id: id(),
  invoiceId: uuid("invoice_id").notNull().references(() => invoices.id),
  amount: paise("amount").notNull(),
  utr: text("utr").unique(),
  allocation: jsonb("allocation"), // principal / interest / fees / penal
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
});

// ---- Module 9: collections ----
// One virtual account per invoice: the buyer pays here, so every credit auto-matches to exactly one invoice.
export const virtualAccounts = pgTable("virtual_accounts", {
  id: id(),
  invoiceId: uuid("invoice_id").notNull().references(() => invoices.id),
  accountNumber: text("account_number").notNull().unique(),
  ifsc: text("ifsc").notNull(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("va_invoice").on(t.invoiceId)]);

// What the seller still owes on a financed invoice. Created at disbursement; accrues daily; closes on full payment.
export const invoiceCollections = pgTable("invoice_collections", {
  invoiceId: uuid("invoice_id").primaryKey().references(() => invoices.id),
  principal: paise("principal").notNull(), // advance outstanding
  discount: paise("discount").notNull().default(sql`0`), // accrued discount outstanding
  penal: paise("penal").notNull().default(sql`0`), // accrued penal charges outstanding
  discountBps: integer("discount_bps").notNull(), // snapshot of the agreed annual rate
  penalBps: integer("penal_bps").notNull(), // annual penal rate on overdue principal
  lastAccruedOn: date("last_accrued_on").notNull(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
});

// Bank credits we couldn't match to a live invoice. Ops resolve these by hand; nothing is silently dropped.
export const unmatchedCredits = pgTable("unmatched_credits", {
  id: id(),
  utr: text("utr").notNull().unique(),
  accountNumber: text("account_number").notNull(),
  amount: paise("amount").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
  reason: text("reason").notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: createdAt(),
});

// Dedupe for reminders/notices: one row per (invoice, step) so a sweep that re-runs never re-sends.
export const collectionEvents = pgTable("collection_events", {
  id: id(),
  invoiceId: uuid("invoice_id").notNull().references(() => invoices.id),
  kind: text("kind").notNull(), // pre_due | due_today | overdue_grace | overdue_7 | overdue_30 | recourse_notice
  createdAt: createdAt(),
}, (t) => [uniqueIndex("ce_invoice_kind").on(t.invoiceId, t.kind)]);

// Money owed back to the seller after the financier is made whole (buyer paid more than principal + discount + penal).
export const sellerPayouts = pgTable("seller_payouts", {
  id: id(),
  repaymentId: uuid("repayment_id").notNull().references(() => repayments.id),
  sellerId: uuid("seller_id").notNull().references(() => businesses.id),
  amount: paise("amount").notNull(),
  status: payStatus("status").notNull().default("pending"),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  bankRef: text("bank_ref"),
  attempts: integer("attempts").notNull().default(0),
  failureReason: text("failure_reason"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("sp_repayment").on(t.repaymentId)]);

// ---- Module 10: double-entry, append-only (enforced in drizzle/ custom SQL) ----
export const ledgerAccounts = pgTable("ledger_accounts", {
  id: id(),
  code: text("code").notNull().unique(), // e.g. escrow, seller:<id>, fee_income
  ownerId: uuid("owner_id"),
});

export const ledgerTransactions = pgTable("ledger_transactions", {
  id: id(),
  ref: text("ref").notNull().unique(), // idempotent business reference
  type: text("type").notNull(), // disbursement | repayment | fee | accrual | reversal
  reversesId: uuid("reverses_id"),
  createdAt: createdAt(),
});

export const ledgerEntries = pgTable("ledger_entries", {
  id: id(),
  transactionId: uuid("transaction_id").notNull().references(() => ledgerTransactions.id),
  accountId: uuid("account_id").notNull().references(() => ledgerAccounts.id),
  direction: direction("direction").notNull(),
  amount: paise("amount").notNull(), // CHECK > 0 in SQL
}, (t) => [index("le_tx").on(t.transactionId), index("le_acct").on(t.accountId)]);

// Bank statement lines for the escrow account (from the bank feed), matched against the ledger at end of day.
export const bankStatementLines = pgTable("bank_statement_lines", {
  id: id(),
  statementDate: date("statement_date").notNull(),
  reference: text("reference").notNull(), // UTR / bank reference
  direction: direction("direction").notNull(), // credit = money in, debit = money out
  amount: paise("amount").notNull(),
  narration: text("narration"),
  status: text("status").notNull().default("pending"), // pending | matched | exception
  exception: text("exception"), // amount_mismatch | no_ledger_entry
  ledgerTxRef: text("ledger_tx_ref"),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("bsl_ref_dir").on(t.reference, t.direction), index("bsl_date").on(t.statementDate)]);

// One row per business date. Must be `tied` (zero variance, no exceptions) before the next day's money movement opens.
export const reconciliationRuns = pgTable("reconciliation_runs", {
  date: date("date").primaryKey(),
  status: text("status").notNull(), // tied | variance
  bankNet: paise("bank_net").notNull(),
  ledgerNet: paise("ledger_net").notNull(),
  variance: paise("variance").notNull(),
  exceptions: jsonb("exceptions").notNull(),
  ranAt: timestamp("ran_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---- Module 16: support, disputes, grievances ----
// One ticket per issue. Level = who is working it: 1 support (ops) -> 2 relationship manager (admin) -> 3 credit/compliance.
export const tickets = pgTable("tickets", {
  id: id(),
  seq: integer("seq").generatedAlwaysAsIdentity().notNull(), // human number: TKT-000123
  kind: text("kind").notNull(), // query | complaint | dispute | grievance
  status: text("status").notNull().default("open"), // open | in_progress | awaiting_customer | resolved
  priority: text("priority").notNull().default("normal"),
  subject: text("subject").notNull(),
  description: text("description").notNull(),
  businessId: uuid("business_id").notNull().references(() => businesses.id), // the raising business
  raisedBy: uuid("raised_by").notNull(),
  invoiceId: uuid("invoice_id").references(() => invoices.id), // transaction context
  level: integer("level").notNull().default(1),
  assignedTo: uuid("assigned_to"),
  firstResponseDueAt: timestamp("first_response_due_at", { withTimezone: true }).notNull(),
  firstResponseAt: timestamp("first_response_at", { withTimezone: true }),
  resolveDueAt: timestamp("resolve_due_at", { withTimezone: true }).notNull(),
  frBreachedAt: timestamp("fr_breached_at", { withTimezone: true }),
  slaBreachedAt: timestamp("sla_breached_at", { withTimezone: true }),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  ombudsmanEscalatedAt: timestamp("ombudsman_escalated_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("ticket_seq").on(t.seq), index("ticket_status").on(t.status), index("ticket_business").on(t.businessId)]);

export const ticketMessages = pgTable("ticket_messages", {
  id: id(),
  ticketId: uuid("ticket_id").notNull().references(() => tickets.id),
  authorId: uuid("author_id"), // null = system
  authorRole: text("author_role").notNull(),
  body: text("body").notNull(),
  internal: boolean("internal").notNull().default(false), // staff-only note, never shown to customers
  createdAt: createdAt(),
}, (t) => [index("tmsg_ticket").on(t.ticketId)]);

// The invoice-dispute workflow. While one is open the invoice is paused: no funding (pre-funding) and no dunning (post-funding).
export const invoiceDisputes = pgTable("invoice_disputes", {
  id: id(),
  ticketId: uuid("ticket_id").notNull().references(() => tickets.id),
  invoiceId: uuid("invoice_id").notNull().references(() => invoices.id),
  phase: text("phase").notNull(), // pre_funding | post_funding
  reason: text("reason").notNull(),
  disputedAmount: paise("disputed_amount"), // null = the whole invoice
  status: text("status").notNull().default("open"), // open | resolved
  outcome: text("outcome"), // invoice_stands | upheld | credit_note
  creditNoteAmount: paise("credit_note_amount"),
  resolutionNote: text("resolution_note"),
  resolvedBy: uuid("resolved_by"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("dispute_ticket").on(t.ticketId),
  uniqueIndex("dispute_open").on(t.invoiceId).where(sql`status = 'open'`), // one live dispute per invoice
]);

// ---- Cross-cutting ----
export const auditLog = pgTable("audit_log", {
  id: id(),
  actorId: uuid("actor_id"),
  action: text("action").notNull(),
  entity: text("entity").notNull(),
  entityId: text("entity_id").notNull(),
  before: jsonb("before"),
  after: jsonb("after"),
  createdAt: createdAt(),
});

// ERP and accounting sync (Phase 2): per-company API keys, and signed webhooks that push status changes back out.
export const apiKeys = pgTable("api_keys", {
  id: id(),
  businessId: uuid("business_id").notNull().references(() => businesses.id),
  kind: text("kind").notNull(), // seller | buyer: what the key may do
  name: text("name").notNull(),
  prefix: text("prefix").notNull(), // first characters, shown so a key can be recognised
  keyHash: text("key_hash").notNull().unique(), // sha256 of the key; the key itself is shown once and never stored
  createdBy: uuid("created_by"),
  createdAt: createdAt(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (t) => [index("api_keys_business").on(t.businessId)]);

export const webhookEndpoints = pgTable("webhook_endpoints", {
  id: id(),
  businessId: uuid("business_id").notNull().references(() => businesses.id),
  url: text("url").notNull(),
  secret: encrypted("secret").notNull(), // signs every delivery; encrypted at rest
  events: text("events").array().notNull().default(sql`'{}'::text[]`), // empty = every event
  active: boolean("active").notNull().default(true),
  createdBy: uuid("created_by"),
  createdAt: createdAt(),
}, (t) => [index("webhook_endpoints_business").on(t.businessId)]);

export const webhookDeliveries = pgTable("webhook_deliveries", {
  id: id(),
  endpointId: uuid("endpoint_id").notNull().references(() => webhookEndpoints.id),
  businessId: uuid("business_id").notNull(),
  type: text("type").notNull(),
  payload: jsonb("payload").notNull(),
  status: text("status").notNull().default("pending"), // pending | delivered | failed
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  lastStatusCode: integer("last_status_code"),
  lastError: text("last_error"),
  createdAt: createdAt(),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
}, (t) => [index("webhook_deliveries_due").on(t.status, t.nextAttemptAt), index("webhook_deliveries_endpoint").on(t.endpointId, t.createdAt)]);

// NACH / e-mandate: a buyer authorises us to debit their bank account for invoices that fall due.
export const mandates = pgTable("mandates", {
  id: id(),
  businessId: uuid("business_id").notNull().references(() => businesses.id), // the buyer
  accountNumber: encrypted("account_number").notNull(),
  ifsc: text("ifsc").notNull(),
  holderName: text("holder_name").notNull(),
  maxAmount: paise("max_amount").notNull(), // the most a single debit may be
  status: text("status").notNull().default("pending"), // pending | active | rejected | revoked
  providerRef: text("provider_ref"),
  createdBy: uuid("created_by"),
  createdAt: createdAt(),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (t) => [index("mandates_business").on(t.businessId, t.status)]);

// One row per debit presented to the buyer's bank. The key makes a retried call a no-op.
export const nachDebits = pgTable("nach_debits", {
  id: id(),
  invoiceId: uuid("invoice_id").notNull().references(() => invoices.id),
  mandateId: uuid("mandate_id").notNull().references(() => mandates.id),
  amount: paise("amount").notNull(),
  attempt: integer("attempt").notNull(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  status: text("status").notNull().default("processing"), // processing | succeeded | failed
  providerRef: text("provider_ref"),
  failureReason: text("failure_reason"),
  presentedAt: timestamp("presented_at", { withTimezone: true }).notNull().defaultNow(),
  settledAt: timestamp("settled_at", { withTimezone: true }),
}, (t) => [index("nach_debits_invoice").on(t.invoiceId)]);

// Credit notes issued by the seller against an invoice (returns, discounts). The invoice amount drops by the credit.
export const creditNotes = pgTable("credit_notes", {
  id: id(),
  invoiceId: uuid("invoice_id").notNull().references(() => invoices.id),
  number: text("number").notNull().unique(), // CN-<invoice number>-<n>
  amount: paise("amount").notNull(),
  amountBefore: paise("amount_before").notNull(), // invoice amount before this credit
  reason: text("reason").notNull(),
  phase: text("phase").notNull(), // pre_funding | post_funding
  issuedBy: uuid("issued_by"),
  createdAt: createdAt(),
}, (t) => [index("credit_notes_invoice").on(t.invoiceId)]);

// Module 12 case queue. An OPEN case on an invoice freezes it (no underwriting/offer/payout) until a reviewer resolves it.
export const fraudCases = pgTable("fraud_cases", {
  id: id(),
  entityType: text("entity_type").notNull(), // invoice | business
  entityId: text("entity_id").notNull(),
  ruleTriggered: text("rule_triggered").notNull(),
  severity: text("severity").notNull().default("medium"), // low | medium | high
  subjectBusinessId: uuid("subject_business_id"), // who the case is about (the party to blacklist if fraud is confirmed)
  details: jsonb("details"),
  status: text("status").notNull().default("open"), // open | closed
  assignedTo: uuid("assigned_to"),
  outcome: text("outcome"), // cleared | confirmed_fraud | rejected
  resolution: text("resolution"),
  resolvedBy: uuid("resolved_by"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  notifiedAt: timestamp("notified_at", { withTimezone: true }), // staff alerted by the worker
  createdAt: createdAt(),
}, (t) => [
  // A repeated trigger while a case is open is the same case, not a new one.
  uniqueIndex("fraud_open_uniq").on(t.entityType, t.entityId, t.ruleTriggered).where(sql`status = 'open'`),
  index("fraud_status").on(t.status),
]);

// Result of the fraud engine scoring one invoice: the weighted signals that fired and their total.
export const fraudScans = pgTable("fraud_scans", {
  invoiceId: uuid("invoice_id").primaryKey().references(() => invoices.id),
  score: integer("score").notNull(),
  signals: jsonb("signals").notNull(), // [{ rule, label, severity, score, detail }]
  scannedAt: timestamp("scanned_at", { withTimezone: true }).notNull().defaultNow(),
});

export const fraudCaseNotes = pgTable("fraud_case_notes", {
  id: id(),
  caseId: uuid("case_id").notNull().references(() => fraudCases.id),
  authorId: uuid("author_id").notNull(),
  note: text("note").notNull(),
  createdAt: createdAt(),
});

// Platform-wide ban list: confirmed fraudsters can't onboard-through, raise invoices or be funded.
export const blacklist = pgTable("blacklist", {
  id: id(),
  businessId: uuid("business_id").notNull().references(() => businesses.id),
  reason: text("reason").notNull(),
  caseId: uuid("case_id").references(() => fraudCases.id),
  createdAt: createdAt(),
  liftedAt: timestamp("lifted_at", { withTimezone: true }),
  liftedBy: uuid("lifted_by"),
}, (t) => [uniqueIndex("blacklist_active").on(t.businessId).where(sql`lifted_at is null`)]);

// Suspicious Transaction Report tracking. Filing itself happens with the regulator; we record that it was done.
export const strReports = pgTable("str_reports", {
  id: id(),
  caseId: uuid("case_id").notNull().references(() => fraudCases.id),
  status: text("status").notNull().default("draft"), // draft | filed
  narrative: text("narrative").notNull(),
  reference: text("reference"), // regulator acknowledgement number
  filedBy: uuid("filed_by"),
  filedAt: timestamp("filed_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("str_case").on(t.caseId)]);

// Outbox + delivery log. Rows are created `queued`, sent inline when possible, and retried by the worker with backoff.
export const notifications = pgTable("notifications", {
  id: id(),
  userId: uuid("user_id").notNull().references(() => users.id),
  channel: text("channel").notNull(), // email | sms
  template: text("template").notNull(),
  toAddress: text("to_address"),
  subject: text("subject"),
  body: text("body"),
  critical: boolean("critical").notNull().default(false),
  status: text("status").notNull().default("queued"), // queued | sending | sent | delivered | read | failed
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  readAt: timestamp("read_at", { withTimezone: true }),
  providerRef: text("provider_ref"),
  error: text("error"),
  createdAt: createdAt(),
}, (t) => [index("notif_due").on(t.status, t.nextAttemptAt), index("notif_user").on(t.userId), index("notif_provider").on(t.providerRef)]);

// Per-user channel opt-out for NON-critical messages. Critical ones (disbursed, overdue, legal notices) always go out.
export const notificationPreferences = pgTable("notification_preferences", {
  userId: uuid("user_id").notNull().references(() => users.id),
  channel: text("channel").notNull(),
  enabled: boolean("enabled").notNull(),
}, (t) => [uniqueIndex("notif_pref").on(t.userId, t.channel)]);

// Phone verification codes. Only a hash is stored, never the code; the code is never written to the notifications log.
export const phoneOtps = pgTable("phone_otps", {
  userId: uuid("user_id").primaryKey().references(() => users.id),
  phone: text("phone").notNull(),
  codeHash: text("code_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  attempts: integer("attempts").notNull().default(0), // wrong guesses against the current code
  sentCount: integer("sent_count").notNull().default(1), // codes requested in the current hour
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
});

// Outbound-call dedupe for the integration gateway (PRD 12.1 idempotency rule).
export const externalCalls = pgTable("external_calls", {
  idempotencyKey: text("idempotency_key").primaryKey(),
  provider: text("provider").notNull(),
  operation: text("operation").notNull(),
  response: jsonb("response"),
  createdAt: createdAt(),
});
