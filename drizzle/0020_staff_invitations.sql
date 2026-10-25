ALTER TABLE "invitations" ALTER COLUMN "business_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "staff_role" text;