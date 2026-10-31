CREATE TABLE "payment_events" (
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"mode" text NOT NULL,
	"type" text NOT NULL,
	"object_id" text,
	"outcome" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_events_provider_event_id_pk" PRIMARY KEY("provider","event_id")
);
--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT "payments_status_check";--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "mode" text DEFAULT 'test' NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "refunded_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "payment_events_received_at_index" ON "payment_events" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "payments_provider_payment_id_index" ON "payments" USING btree ("provider_payment_id");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_mode_check" CHECK ("payments"."mode" in ('test', 'live'));--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_status_check" CHECK ("payments"."status" in ('pending', 'paid', 'failed', 'review', 'refunded'));