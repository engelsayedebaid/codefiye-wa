CREATE TABLE "plans" (
	"key" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"egp" integer DEFAULT 0 NOT NULL,
	"sessions" integer DEFAULT 1 NOT NULL,
	"daily_messages" integer,
	"internal" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);

-- Seed from shared PLANS.
INSERT INTO "plans" ("key", "name", "egp", "sessions", "daily_messages", "internal", "enabled", "sort_order") VALUES
	('trial', 'تجريبي', 0, 1, 50, false, true, 0),
	('basic', 'Basic', 300, 1, NULL, false, true, 10),
	('pro', 'Pro', 750, 3, NULL, false, true, 20),
	('plus', 'Plus', 1500, 6, NULL, false, true, 30),
	('business', 'Business', 2250, 10, NULL, false, true, 40),
	('unlimited', 'غير محدود', 0, 9999, NULL, true, true, 90);
