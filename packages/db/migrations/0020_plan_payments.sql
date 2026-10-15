ALTER TABLE "plan_requests" ADD COLUMN "months" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "plan_requests" ADD COLUMN "payment" jsonb;--> statement-breakpoint
ALTER TABLE "plan_requests" ADD COLUMN "proof_mimetype" text;--> statement-breakpoint
ALTER TABLE "plan_requests" ADD COLUMN "proof" "bytea";