-- Hardening (docs/HARDENING.md §3.1). Additive: every existing row keeps working.
CREATE TABLE "audit_logs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_logs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"actor_id" uuid,
	"actor_email" text,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"target_label" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "phone_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purpose" text NOT NULL,
	"user_id" uuid,
	"phone" text NOT NULL,
	"email" text,
	"name" text,
	"password_hash" text,
	"lang" text DEFAULT 'ar' NOT NULL,
	"code_hash" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"sends" integer DEFAULT 1 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consumed_at" timestamp with time zone,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "phone_verifications_purpose_check" CHECK ("phone_verifications"."purpose" in ('register', 'phone'))
);
--> statement-breakpoint
CREATE TABLE "throttles" (
	"key" text PRIMARY KEY NOT NULL,
	"hits" integer NOT NULL,
	"reset_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
-- Roles: `role` becomes the source of truth. Copy the admins over before `is_admin` turns into a
-- column derived from it, so code deployed earlier that still reads `is_admin` sees the same values.
ALTER TABLE "users" ADD COLUMN "role" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
UPDATE "users" SET "role" = 'admin' WHERE "is_admin";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "is_admin";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_admin" boolean GENERATED ALWAYS AS (role = 'admin') STORED;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "suspended_reason" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "phone_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "phone_verifications" ADD CONSTRAINT "phone_verifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_created_at_index" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_target_type_target_id_index" ON "audit_logs" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "phone_verifications_expires_at_index" ON "phone_verifications" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "phone_verifications_user_id_index" ON "phone_verifications" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "throttles_reset_at_index" ON "throttles" USING btree ("reset_at");--> statement-breakpoint
-- One pending plan request per workspace: keep the newest of any earlier duplicates.
UPDATE "plan_requests" SET "status" = 'cancelled', "decided_at" = now()
WHERE "status" = 'pending' AND "id" NOT IN (
	SELECT DISTINCT ON ("workspace_id") "id" FROM "plan_requests" WHERE "status" = 'pending' ORDER BY "workspace_id", "created_at" DESC
);--> statement-breakpoint
CREATE UNIQUE INDEX "plan_requests_one_pending_idx" ON "plan_requests" USING btree ("workspace_id") WHERE "plan_requests"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "users_verified_phone_idx" ON "users" USING btree ("phone") WHERE "users"."phone_verified_at" is not null;--> statement-breakpoint
CREATE INDEX "workspaces_owner_id_index" ON "workspaces" USING btree ("owner_id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_check" CHECK ("users"."role" in ('user', 'admin'));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_status_check" CHECK ("users"."status" in ('active', 'suspended'));--> statement-breakpoint
-- No query may hang forever, and an abandoned transaction can't hold locks or a pooled connection.
-- Scoped to this role in this database only (other databases on the same server are untouched);
-- best-effort, since some hosts don't let the app role change its own defaults.
DO $$
BEGIN
	EXECUTE format('ALTER ROLE %I IN DATABASE %I SET statement_timeout = %L', current_user, current_database(), '30s');
	EXECUTE format('ALTER ROLE %I IN DATABASE %I SET idle_in_transaction_session_timeout = %L', current_user, current_database(), '60s');
EXCEPTION WHEN insufficient_privilege THEN
	RAISE NOTICE 'per-role timeouts not set: %', SQLERRM;
END $$;
