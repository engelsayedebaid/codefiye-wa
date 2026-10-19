CREATE TABLE "ai_provider_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" text NOT NULL,
	"label" text NOT NULL,
	"api_key" "bytea" NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"model" text,
	"base_url" text,
	"total_requests" integer DEFAULT 0 NOT NULL,
	"success_requests" integer DEFAULT 0 NOT NULL,
	"failed_requests" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"cooldown_until" timestamp with time zone,
	"circuit_state" text DEFAULT 'closed' NOT NULL,
	"circuit_opened_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_provider_keys" ADD CONSTRAINT "ai_provider_keys_provider_id_ai_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."ai_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_provider_keys_provider_id_priority_enabled_index" ON "ai_provider_keys" USING btree ("provider_id","priority","enabled");--> statement-breakpoint
CREATE INDEX "ai_provider_keys_cooldown_until_index" ON "ai_provider_keys" USING btree ("cooldown_until");--> statement-breakpoint
CREATE INDEX "ai_provider_keys_circuit_state_index" ON "ai_provider_keys" USING btree ("circuit_state");--> statement-breakpoint
ALTER TABLE "ai_providers" DROP COLUMN "api_key";