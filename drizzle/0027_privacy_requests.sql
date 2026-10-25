CREATE TABLE "privacy_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"details" text,
	"status" text DEFAULT 'received' NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"resolution" text,
	"handled_by" uuid,
	"export_data" jsonb,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "privacy_requests" ADD CONSTRAINT "privacy_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "privacy_user" ON "privacy_requests" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "privacy_open" ON "privacy_requests" USING btree ("status","due_at");