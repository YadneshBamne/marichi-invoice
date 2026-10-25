CREATE TABLE "business_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"document_ref" text NOT NULL,
	"document_hash" text NOT NULL,
	"filename" text NOT NULL,
	"reading" text DEFAULT 'read' NOT NULL,
	"extracted" jsonb,
	"flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"valid_until" date,
	"uploaded_by" uuid,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "udyam" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "doc_fingerprint" jsonb;--> statement-breakpoint
ALTER TABLE "business_documents" ADD CONSTRAINT "business_documents_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bizdoc_business" ON "business_documents" USING btree ("business_id","kind");