ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "otp_pool_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "priority" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "otp_challenge_id" uuid;--> statement-breakpoint
CREATE TABLE "otp_sender_pools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"code_length" integer DEFAULT 6 NOT NULL,
	"ttl_seconds" integer DEFAULT 300 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"resend_cooldown_sec" integer DEFAULT 60 NOT NULL,
	"max_sends" integer DEFAULT 5 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "otp_sender_pools_status_check" CHECK ("status" in ('active', 'paused', 'archived'))
);--> statement-breakpoint
CREATE TABLE "otp_sender_pool_members" (
	"pool_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"membership" text DEFAULT 'active' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "otp_sender_pool_members_pkey" PRIMARY KEY("pool_id","session_id"),
	CONSTRAINT "otp_sender_pool_members_membership_check" CHECK ("membership" in ('active', 'draining'))
);--> statement-breakpoint
CREATE TABLE "otp_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"pool_id" uuid,
	"session_id" uuid,
	"phone" text NOT NULL,
	"purpose" text NOT NULL,
	"lang" text DEFAULT 'ar' NOT NULL,
	"code_hash" text NOT NULL,
	"delivery_ciphertext" "bytea",
	"expires_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"sends" integer DEFAULT 1 NOT NULL,
	"max_sends" integer DEFAULT 5 NOT NULL,
	"resend_cooldown_sec" integer DEFAULT 60 NOT NULL,
	"last_sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consumed_at" timestamp with time zone,
	"verify_status" text DEFAULT 'open' NOT NULL,
	"delivery_status" text DEFAULT 'queued' NOT NULL,
	"send_started" boolean DEFAULT false NOT NULL,
	"idempotency_key" text,
	"message_id" bigint,
	"failure" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "otp_challenges_verify_status_check" CHECK ("verify_status" in ('open', 'verified', 'expired', 'locked')),
	CONSTRAINT "otp_challenges_delivery_status_check" CHECK ("delivery_status" in ('queued', 'processing', 'sent', 'delivered', 'failed', 'expired', 'uncertain'))
);--> statement-breakpoint
CREATE TABLE "otp_usage_daily" (
	"workspace_id" uuid NOT NULL,
	"day" date NOT NULL,
	"admitted" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "otp_usage_daily_pkey" PRIMARY KEY("workspace_id","day")
);--> statement-breakpoint
ALTER TABLE "otp_sender_pools" ADD CONSTRAINT "otp_sender_pools_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "otp_sender_pool_members" ADD CONSTRAINT "otp_sender_pool_members_pool_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."otp_sender_pools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "otp_sender_pool_members" ADD CONSTRAINT "otp_sender_pool_members_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "otp_challenges" ADD CONSTRAINT "otp_challenges_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "otp_challenges" ADD CONSTRAINT "otp_challenges_pool_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."otp_sender_pools"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "otp_challenges" ADD CONSTRAINT "otp_challenges_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "otp_usage_daily" ADD CONSTRAINT "otp_usage_daily_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_otp_pool_id_fk" FOREIGN KEY ("otp_pool_id") REFERENCES "public"."otp_sender_pools"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_otp_challenge_id_fk" FOREIGN KEY ("otp_challenge_id") REFERENCES "public"."otp_challenges"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "otp_sender_pools_workspace_id_index" ON "otp_sender_pools" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "otp_sender_pools_one_default" ON "otp_sender_pools" USING btree ("workspace_id") WHERE "is_default" = true AND "status" <> 'archived';--> statement-breakpoint
CREATE INDEX "otp_sender_pool_members_session_id_index" ON "otp_sender_pool_members" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "otp_challenges_workspace_created_index" ON "otp_challenges" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "otp_challenges_pool_created_index" ON "otp_challenges" USING btree ("pool_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "otp_challenges_idem_idx" ON "otp_challenges" USING btree ("workspace_id","idempotency_key") WHERE "idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "messages_otp_queue_idx" ON "messages" USING btree ("session_id","priority","id") WHERE "otp_challenge_id" is not null AND "status" = 'queued';