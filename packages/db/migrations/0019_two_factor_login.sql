CREATE TABLE "login_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"remember" boolean DEFAULT true NOT NULL,
	"ip" text,
	"user_agent" text,
	"phone_verification_id" uuid,
	"phone_verified_at" timestamp with time zone,
	"totp_verified_at" timestamp with time zone,
	"totp_attempts" integer DEFAULT 0 NOT NULL,
	"approval" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "login_attempts_approval_check" CHECK ("login_attempts"."approval" in ('pending', 'approved', 'denied'))
);
--> statement-breakpoint
ALTER TABLE "phone_verifications" DROP CONSTRAINT "phone_verifications_purpose_check";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_secret" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_enabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_last_step" bigint;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "recovery_codes" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "login_attempts" ADD CONSTRAINT "login_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "login_attempts" ADD CONSTRAINT "login_attempts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "login_attempts" ADD CONSTRAINT "login_attempts_phone_verification_id_phone_verifications_id_fk" FOREIGN KEY ("phone_verification_id") REFERENCES "public"."phone_verifications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "login_attempts_user_id_approval_index" ON "login_attempts" USING btree ("user_id","approval");--> statement-breakpoint
CREATE INDEX "login_attempts_expires_at_index" ON "login_attempts" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "phone_verifications" ADD CONSTRAINT "phone_verifications_purpose_check" CHECK ("phone_verifications"."purpose" in ('register', 'phone', 'login'));