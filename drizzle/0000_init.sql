CREATE TYPE "public"."direction" AS ENUM('debit', 'credit');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('uploaded', 'validated', 'sent_for_confirmation', 'confirmed', 'disputed', 'eligible', 'financed', 'due', 'paid', 'overdue', 'written_off', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."kyb_level" AS ENUM('light', 'full');--> statement-breakpoint
CREATE TYPE "public"."kyc_status" AS ENUM('draft', 'submitted', 'under_review', 'info_requested', 'approved', 'rejected', 'rekyc_due');--> statement-breakpoint
CREATE TYPE "public"."offer_status" AS ENUM('open', 'accepted', 'expired', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."pay_status" AS ENUM('pending', 'processing', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('seller', 'buyer', 'financier', 'admin', 'ops', 'compliance');--> statement-breakpoint
CREATE TABLE "account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agreements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"offer_id" uuid,
	"kind" text NOT NULL,
	"document_ref" text NOT NULL,
	"document_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"esign_request_id" text,
	"sent_at" timestamp with time zone,
	"signed_at" timestamp with time zone,
	"signed_by" uuid,
	"signed_by_email" text,
	"signed_ip" text,
	"signed_user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_statement_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"statement_date" date NOT NULL,
	"reference" text NOT NULL,
	"direction" "direction" NOT NULL,
	"amount" bigint NOT NULL,
	"narration" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"exception" text,
	"ledger_tx_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blacklist" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"case_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lifted_at" timestamp with time zone,
	"lifted_by" uuid
);
--> statement-breakpoint
CREATE TABLE "business_bank_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"account_number" text NOT NULL,
	"ifsc" text NOT NULL,
	"holder_name" text NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"name_match" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "businesses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"legal_name" text NOT NULL,
	"entity_type" text NOT NULL,
	"gstin" text,
	"pan" text,
	"cin" text,
	"kyb_status" "kyc_status" DEFAULT 'draft' NOT NULL,
	"kyb_note" text,
	"kyb_level" "kyb_level" DEFAULT 'full' NOT NULL,
	"credit_limit" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "businesses_gstin_unique" UNIQUE("gstin")
);
--> statement-breakpoint
CREATE TABLE "buyer_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seller_id" uuid NOT NULL,
	"buyer_gstin" text NOT NULL,
	"buyer_email" text NOT NULL,
	"credit_terms_days" integer DEFAULT 60 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "buyer_seller_relationships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"buyer_id" uuid NOT NULL,
	"seller_id" uuid NOT NULL,
	"program_id" uuid,
	"credit_terms_days" integer DEFAULT 60 NOT NULL,
	"max_exposure" bigint,
	"deemed_acceptance_days" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "collection_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"user_id" uuid,
	"purpose" text NOT NULL,
	"text" text NOT NULL,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "disbursements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"offer_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"bank_ref" text,
	"status" "pay_status" DEFAULT 'pending' NOT NULL,
	"idempotency_key" text NOT NULL,
	"maker_id" uuid,
	"needs_approval" boolean DEFAULT false NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"rail" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"failure_reason" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "disbursements_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "external_calls" (
	"idempotency_key" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"operation" text NOT NULL,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "financing_offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"financier_id" uuid,
	"advance_amount" bigint NOT NULL,
	"discount_bps" integer NOT NULL,
	"fee_amount" bigint DEFAULT 0 NOT NULL,
	"tenor_days" integer NOT NULL,
	"expected_discount" bigint NOT NULL,
	"recourse" boolean DEFAULT true NOT NULL,
	"status" "offer_status" DEFAULT 'open' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fraud_case_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"note" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fraud_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"rule_triggered" text NOT NULL,
	"severity" text DEFAULT 'medium' NOT NULL,
	"subject_business_id" uuid,
	"details" jsonb,
	"status" text DEFAULT 'open' NOT NULL,
	"assigned_to" uuid,
	"outcome" text,
	"resolution" text,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_collections" (
	"invoice_id" uuid PRIMARY KEY NOT NULL,
	"principal" bigint NOT NULL,
	"discount" bigint DEFAULT 0 NOT NULL,
	"penal" bigint DEFAULT 0 NOT NULL,
	"discount_bps" integer NOT NULL,
	"penal_bps" integer NOT NULL,
	"last_accrued_on" date NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "invoice_confirmations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"method" text,
	"sent_at" timestamp with time zone NOT NULL,
	"responded_at" timestamp with time zone,
	"responded_by" uuid,
	"responded_by_email" text,
	"ip" text,
	"user_agent" text,
	"note" text,
	"reminder_24_at" timestamp with time zone,
	"reminder_48_at" timestamp with time zone,
	"escalated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "invoice_disputes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"phase" text NOT NULL,
	"reason" text NOT NULL,
	"disputed_amount" bigint,
	"status" text DEFAULT 'open' NOT NULL,
	"outcome" text,
	"credit_note_amount" bigint,
	"resolution_note" text,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seller_id" uuid NOT NULL,
	"buyer_id" uuid NOT NULL,
	"invoice_number" text NOT NULL,
	"invoice_date" date NOT NULL,
	"due_date" date NOT NULL,
	"amount" bigint NOT NULL,
	"tax_breakup" jsonb,
	"line_items" jsonb,
	"po_reference" text,
	"irn" text,
	"content_hash" text NOT NULL,
	"document_ref" text,
	"irn_status" text DEFAULT 'absent' NOT NULL,
	"review_note" text,
	"status" "invoice_status" DEFAULT 'uploaded' NOT NULL,
	"dispute_flag" boolean DEFAULT false NOT NULL,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"owner_id" uuid,
	CONSTRAINT "ledger_accounts_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"direction" "direction" NOT NULL,
	"amount" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ref" text NOT NULL,
	"type" text NOT NULL,
	"reverses_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_transactions_ref_unique" UNIQUE("ref")
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"user_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"enabled" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"template" text NOT NULL,
	"to_address" text,
	"subject" text,
	"body" text,
	"critical" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"provider_ref" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "phone_otps" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"phone" text NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"sent_count" integer DEFAULT 1 NOT NULL,
	"window_start" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reconciliation_runs" (
	"date" date PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"bank_net" bigint NOT NULL,
	"ledger_net" bigint NOT NULL,
	"variance" bigint NOT NULL,
	"exceptions" jsonb NOT NULL,
	"ran_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repayments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"utr" text,
	"allocation" jsonb,
	"received_at" timestamp with time zone NOT NULL,
	CONSTRAINT "repayments_utr_unique" UNIQUE("utr")
);
--> statement-breakpoint
CREATE TABLE "seller_payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repayment_id" uuid NOT NULL,
	"seller_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"status" "pay_status" DEFAULT 'pending' NOT NULL,
	"idempotency_key" text NOT NULL,
	"bank_ref" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"failure_reason" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seller_payouts_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" uuid NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "str_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"narrative" text NOT NULL,
	"reference" text,
	"filed_by" uuid,
	"filed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"author_id" uuid,
	"author_role" text NOT NULL,
	"body" text NOT NULL,
	"internal" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" integer GENERATED ALWAYS AS IDENTITY (sequence name "tickets_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"kind" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"subject" text NOT NULL,
	"description" text NOT NULL,
	"business_id" uuid NOT NULL,
	"raised_by" uuid NOT NULL,
	"invoice_id" uuid,
	"level" integer DEFAULT 1 NOT NULL,
	"assigned_to" uuid,
	"first_response_due_at" timestamp with time zone NOT NULL,
	"first_response_at" timestamp with time zone,
	"resolve_due_at" timestamp with time zone NOT NULL,
	"fr_breached_at" timestamp with time zone,
	"sla_breached_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"ombudsman_escalated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "two_factor" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"user_id" uuid NOT NULL,
	"verified" boolean DEFAULT true,
	"failed_verification_count" integer DEFAULT 0,
	"locked_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ubos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"name" text NOT NULL,
	"din" text,
	"shareholding_bps" integer NOT NULL,
	"pep_flag" boolean DEFAULT false NOT NULL,
	"screening_score" integer,
	"screening_hit" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "underwriting_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"risk_grade" text NOT NULL,
	"pd" numeric(6, 4),
	"advance_rate_bps" integer NOT NULL,
	"discount_rate_bps" integer NOT NULL,
	"reasons" jsonb NOT NULL,
	"inputs" jsonb NOT NULL,
	"decided_by" text DEFAULT 'rules-v1' NOT NULL,
	"review_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "unmatched_credits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"utr" text NOT NULL,
	"account_number" text NOT NULL,
	"amount" bigint NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "unmatched_credits_utr_unique" UNIQUE("utr")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"two_factor_enabled" boolean DEFAULT false,
	"phone" text,
	"phone_verified" boolean DEFAULT false NOT NULL,
	"role" "role" DEFAULT 'seller' NOT NULL,
	"business_id" uuid,
	"kyc_status" "kyc_status" DEFAULT 'draft' NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "virtual_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"account_number" text NOT NULL,
	"ifsc" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "virtual_accounts_account_number_unique" UNIQUE("account_number")
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agreements" ADD CONSTRAINT "agreements_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agreements" ADD CONSTRAINT "agreements_offer_id_financing_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."financing_offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blacklist" ADD CONSTRAINT "blacklist_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blacklist" ADD CONSTRAINT "blacklist_case_id_fraud_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."fraud_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_bank_accounts" ADD CONSTRAINT "business_bank_accounts_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buyer_invites" ADD CONSTRAINT "buyer_invites_seller_id_businesses_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buyer_seller_relationships" ADD CONSTRAINT "buyer_seller_relationships_buyer_id_businesses_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buyer_seller_relationships" ADD CONSTRAINT "buyer_seller_relationships_seller_id_businesses_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_events" ADD CONSTRAINT "collection_events_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disbursements" ADD CONSTRAINT "disbursements_offer_id_financing_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."financing_offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financing_offers" ADD CONSTRAINT "financing_offers_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fraud_case_notes" ADD CONSTRAINT "fraud_case_notes_case_id_fraud_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."fraud_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_collections" ADD CONSTRAINT "invoice_collections_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_confirmations" ADD CONSTRAINT "invoice_confirmations_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_disputes" ADD CONSTRAINT "invoice_disputes_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_disputes" ADD CONSTRAINT "invoice_disputes_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_seller_id_businesses_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_buyer_id_businesses_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_account_id_ledger_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_otps" ADD CONSTRAINT "phone_otps_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repayments" ADD CONSTRAINT "repayments_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_payouts" ADD CONSTRAINT "seller_payouts_repayment_id_repayments_id_fk" FOREIGN KEY ("repayment_id") REFERENCES "public"."repayments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_payouts" ADD CONSTRAINT "seller_payouts_seller_id_businesses_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "str_reports" ADD CONSTRAINT "str_reports_case_id_fraud_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."fraud_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "two_factor" ADD CONSTRAINT "two_factor_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ubos" ADD CONSTRAINT "ubos_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "underwriting_decisions" ADD CONSTRAINT "underwriting_decisions_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "virtual_accounts" ADD CONSTRAINT "virtual_accounts_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agr_master" ON "agreements" USING btree ("business_id") WHERE kind = 'master';--> statement-breakpoint
CREATE UNIQUE INDEX "agr_offer_kind" ON "agreements" USING btree ("offer_id","kind") WHERE offer_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "agr_esign_req" ON "agreements" USING btree ("esign_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bsl_ref_dir" ON "bank_statement_lines" USING btree ("reference","direction");--> statement-breakpoint
CREATE INDEX "bsl_date" ON "bank_statement_lines" USING btree ("statement_date");--> statement-breakpoint
CREATE UNIQUE INDEX "blacklist_active" ON "blacklist" USING btree ("business_id") WHERE lifted_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "invite_pair" ON "buyer_invites" USING btree ("seller_id","buyer_gstin");--> statement-breakpoint
CREATE UNIQUE INDEX "bsr_pair" ON "buyer_seller_relationships" USING btree ("buyer_id","seller_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ce_invoice_kind" ON "collection_events" USING btree ("invoice_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "disb_offer" ON "disbursements" USING btree ("offer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "offer_live" ON "financing_offers" USING btree ("invoice_id") WHERE status in ('open','accepted');--> statement-breakpoint
CREATE UNIQUE INDEX "fraud_open_uniq" ON "fraud_cases" USING btree ("entity_type","entity_id","rule_triggered") WHERE status = 'open';--> statement-breakpoint
CREATE INDEX "fraud_status" ON "fraud_cases" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "conf_invoice" ON "invoice_confirmations" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dispute_ticket" ON "invoice_disputes" USING btree ("ticket_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dispute_open" ON "invoice_disputes" USING btree ("invoice_id") WHERE status = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "inv_irn_uniq" ON "invoices" USING btree ("irn");--> statement-breakpoint
CREATE UNIQUE INDEX "inv_hash_uniq" ON "invoices" USING btree ("content_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "inv_seller_no" ON "invoices" USING btree ("seller_id","invoice_number");--> statement-breakpoint
CREATE INDEX "inv_status" ON "invoices" USING btree ("status");--> statement-breakpoint
CREATE INDEX "le_tx" ON "ledger_entries" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "le_acct" ON "ledger_entries" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notif_pref" ON "notification_preferences" USING btree ("user_id","channel");--> statement-breakpoint
CREATE INDEX "notif_due" ON "notifications" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "notif_user" ON "notifications" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "notif_provider" ON "notifications" USING btree ("provider_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "sp_repayment" ON "seller_payouts" USING btree ("repayment_id");--> statement-breakpoint
CREATE INDEX "session_user" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "str_case" ON "str_reports" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "tmsg_ticket" ON "ticket_messages" USING btree ("ticket_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_seq" ON "tickets" USING btree ("seq");--> statement-breakpoint
CREATE INDEX "ticket_status" ON "tickets" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ticket_business" ON "tickets" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "two_factor_user" ON "two_factor" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uw_invoice" ON "underwriting_decisions" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "verification_identifier" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "va_invoice" ON "virtual_accounts" USING btree ("invoice_id");