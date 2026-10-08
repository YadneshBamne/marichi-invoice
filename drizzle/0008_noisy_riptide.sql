CREATE TABLE "ml_scores" (
	"invoice_id" uuid PRIMARY KEY NOT NULL,
	"version" text NOT NULL,
	"pd" numeric(8, 6) NOT NULL,
	"grade" text NOT NULL,
	"rules_grade" text NOT NULL,
	"rules_decision" text NOT NULL,
	"final_decision" text NOT NULL,
	"reasons" jsonb NOT NULL,
	"features" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ml_scores" ADD CONSTRAINT "ml_scores_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;