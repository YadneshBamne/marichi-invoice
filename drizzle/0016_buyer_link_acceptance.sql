ALTER TABLE "buyer_seller_relationships" ADD COLUMN "contact_email" text;--> statement-breakpoint
ALTER TABLE "invoice_confirmations" ADD COLUMN "token_hash" text;--> statement-breakpoint
ALTER TABLE "invoice_confirmations" ADD COLUMN "token" text;--> statement-breakpoint
ALTER TABLE "invoice_confirmations" ADD COLUMN "token_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invoice_confirmations" ADD COLUMN "otp_hash" text;--> statement-breakpoint
ALTER TABLE "invoice_confirmations" ADD COLUMN "otp_email" text;--> statement-breakpoint
ALTER TABLE "invoice_confirmations" ADD COLUMN "otp_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invoice_confirmations" ADD COLUMN "otp_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invoice_confirmations" ADD COLUMN "otp_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice_confirmations" ADD COLUMN "verified_email" text;--> statement-breakpoint
ALTER TABLE "invoice_confirmations" ADD COLUMN "claim_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invoice_confirmations" ADD COLUMN "acceptance_version" text;--> statement-breakpoint
ALTER TABLE "invoice_confirmations" ADD COLUMN "acceptance_text" text;--> statement-breakpoint
ALTER TABLE "invoice_confirmations" ADD CONSTRAINT "invoice_confirmations_token_hash_unique" UNIQUE("token_hash");