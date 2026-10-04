-- Repairs databases where 0010 was applied before its trigger and backfill were added to it (a dev
-- worker migrated mid-edit). Safe to run where everything already exists.
CREATE OR REPLACE FUNCTION chat_jid_of(direction text, remote_jid text, content jsonb) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN direction = 'in' AND remote_jid LIKE '%@lid' AND content->>'from' LIKE '%@s.whatsapp.net' THEN content->>'from'
    ELSE remote_jid
  END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS messages_chats ON messages;
--> statement-breakpoint
CREATE TRIGGER messages_chats AFTER INSERT ON messages
REFERENCING NEW TABLE AS new_messages
FOR EACH STATEMENT EXECUTE FUNCTION chats_on_messages();
--> statement-breakpoint
-- Conversations missing a row, all read.
INSERT INTO chats (session_id, jid, workspace_id, alt_jid, name, last_message_id, last_message_at,
                   last_inbound_at, last_outbound_at, inbound_count, outbound_count, unread_count, created_at)
SELECT m.session_id, m.chat_jid, m.workspace_id,
       max(m.alt_jid),
       (array_agg(m.push_name ORDER BY m.created_at DESC, m.id DESC) FILTER (WHERE m.push_name IS NOT NULL))[1],
       (array_agg(m.id ORDER BY m.created_at DESC, m.id DESC))[1],
       max(m.created_at),
       max(m.created_at) FILTER (WHERE m.direction = 'in'),
       max(m.created_at) FILTER (WHERE m.direction = 'out'),
       count(*) FILTER (WHERE m.direction = 'in'),
       count(*) FILTER (WHERE m.direction = 'out'),
       0,
       min(m.created_at)
FROM (
  SELECT n.id, n.session_id, n.workspace_id, n.direction, n.created_at,
         chat_jid_of(n.direction, n.remote_jid, n.content) AS chat_jid,
         CASE WHEN chat_jid_of(n.direction, n.remote_jid, n.content) <> n.remote_jid THEN n.remote_jid END AS alt_jid,
         CASE WHEN n.direction = 'in' AND n.remote_jid NOT LIKE '%@g.us' THEN nullif(n.content->>'pushName', '') END AS push_name
  FROM messages n
  WHERE n.type <> 'reaction'
) m
GROUP BY m.session_id, m.chat_jid, m.workspace_id
ON CONFLICT (session_id, jid) DO NOTHING;
