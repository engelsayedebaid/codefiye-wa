-- Group messages from a history sync carry their sender beside the key (`participant`), which was not
-- read: they were stored as sent by the group itself. Repair the ones whose raw message is kept
-- (media); the rest are repaired when the same history comes back (a sync updates the sender).
UPDATE messages SET content = content || jsonb_build_object(
    'from', wa_user_jid(raw->>'participant'),
    'fromPhone', CASE WHEN raw->>'participant' LIKE '%@s.whatsapp.net' THEN '+' || split_part(split_part(raw->>'participant', '@', 1), ':', 1) END)
WHERE direction = 'in' AND remote_jid LIKE '%@g.us' AND content->>'from' LIKE '%@g.us' AND raw->>'participant' LIKE '%@%';
--> statement-breakpoint
-- A sender's latest WhatsApp name (group senders are named from their own messages).
CREATE INDEX IF NOT EXISTS "messages_inbound_sender_index" ON "messages" ("session_id", (content->>'from'), "id") WHERE direction = 'in';
