CREATE TABLE "auto_reply_summaries" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "auto_reply_summaries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"session_id" uuid NOT NULL,
	"chat_jid" text NOT NULL,
	"last_message_id" bigint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"message_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auto_reply_settings" ADD COLUMN "summary_phone" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "auto_reply_settings" ADD COLUMN "summary_idle_minutes" integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE "auto_reply_summaries" ADD CONSTRAINT "auto_reply_summaries_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auto_reply_summaries_session_id_chat_jid_last_message_id_index" ON "auto_reply_summaries" USING btree ("session_id","chat_jid","last_message_id");--> statement-breakpoint
CREATE INDEX "auto_reply_summaries_session_id_created_at_index" ON "auto_reply_summaries" USING btree ("session_id","created_at");