CREATE TABLE "legal_notices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" integer GENERATED ALWAYS AS IDENTITY (sequence name "legal_notices_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"invoice_id" uuid NOT NULL,
	"addressee" text NOT NULL,
	"addressee_id" uuid NOT NULL,
	"amount_due" bigint NOT NULL,
	"breakdown" jsonb NOT NULL,
	"dpd" integer NOT NULL,
	"cure_by" date NOT NULL,
	"document_ref" text NOT NULL,
	"status" text DEFAULT 'issued' NOT NULL,
	"issued_by" uuid NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"agency" text,
	"handoff_note" text,
	"handed_over_by" uuid,
	"handed_over_at" timestamp with time zone,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "legal_notices" ADD CONSTRAINT "legal_notices_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_notices" ADD CONSTRAINT "legal_notices_addressee_id_businesses_id_fk" FOREIGN KEY ("addressee_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "legal_seq" ON "legal_notices" USING btree ("seq");--> statement-breakpoint
CREATE UNIQUE INDEX "legal_live" ON "legal_notices" USING btree ("invoice_id","addressee") WHERE status in ('issued', 'handed_over');--> statement-breakpoint
CREATE INDEX "legal_status" ON "legal_notices" USING btree ("status");