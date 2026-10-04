CREATE TABLE "opt_outs" (
	"workspace_id" uuid NOT NULL,
	"phone" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "opt_outs_workspace_id_phone_pk" PRIMARY KEY("workspace_id","phone")
);
--> statement-breakpoint
ALTER TABLE "broadcasts" ADD COLUMN "sending_window" jsonb;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "restricted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "opt_outs" ADD CONSTRAINT "opt_outs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messages_campaign_sent_idx" ON "messages" USING btree ("session_id","sent_at") WHERE "messages"."broadcast_id" is not null;