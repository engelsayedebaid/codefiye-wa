CREATE TYPE "public"."payment_method" AS ENUM('instapay', 'vodafone_cash', 'bank_transfer', 'fawry', 'other');--> statement-breakpoint
CREATE TYPE "public"."payment_request_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TABLE "payment_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"plan_id" text NOT NULL,
	"amount_egp" integer NOT NULL,
	"months" integer DEFAULT 1 NOT NULL,
	"method" "payment_method" NOT NULL,
	"reference" text,
	"note" text,
	"status" "payment_request_status" DEFAULT 'pending' NOT NULL,
	"admin_note" text,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "plan_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_requests" ADD CONSTRAINT "payment_requests_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_requests_workspace_id_created_at_index" ON "payment_requests" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "payment_requests_status_index" ON "payment_requests" USING btree ("status");