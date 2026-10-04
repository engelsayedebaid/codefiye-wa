CREATE INDEX "messages_chat_time_idx" ON "messages" USING btree ("session_id","remote_jid","created_at","id");--> statement-breakpoint
-- History synced from the phone arrives after newer messages, with its own (older) time. A chat's
-- last message is therefore the newest by time, not by id; and synced messages (content.history)
-- are already read on the phone: they never add to unread nor bring an archived chat back.
CREATE OR REPLACE FUNCTION chats_on_messages() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO chats AS c (session_id, jid, workspace_id, alt_jid, name, last_message_id, last_message_at,
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
         count(*) FILTER (WHERE m.direction = 'in' AND NOT m.history),
         min(m.created_at)
  FROM (
    SELECT n.id, n.session_id, n.workspace_id, n.direction, n.created_at,
           chat_jid_of(n.direction, n.remote_jid, n.content) AS chat_jid,
           CASE WHEN chat_jid_of(n.direction, n.remote_jid, n.content) <> n.remote_jid THEN n.remote_jid END AS alt_jid,
           CASE WHEN n.direction = 'in' AND n.remote_jid NOT LIKE '%@g.us' THEN nullif(n.content->>'pushName', '') END AS push_name,
           coalesce((n.content->>'history')::boolean, false) AS history
    FROM new_messages n
    WHERE n.type <> 'reaction'
  ) m
  GROUP BY m.session_id, m.chat_jid, m.workspace_id
  ORDER BY m.session_id, m.chat_jid
  ON CONFLICT (session_id, jid) DO UPDATE SET
    alt_jid = coalesce(excluded.alt_jid, c.alt_jid),
    -- The name of the newest message wins, so an older synced message never renames a chat.
    name = CASE
      WHEN c.jid LIKE '%@g.us' THEN c.name
      WHEN excluded.last_message_at >= c.last_message_at THEN coalesce(excluded.name, c.name)
      ELSE coalesce(c.name, excluded.name)
    END,
    last_message_id = CASE WHEN excluded.last_message_at >= c.last_message_at THEN excluded.last_message_id ELSE c.last_message_id END,
    last_message_at = greatest(c.last_message_at, excluded.last_message_at),
    last_inbound_at = greatest(c.last_inbound_at, excluded.last_inbound_at),
    last_outbound_at = greatest(c.last_outbound_at, excluded.last_outbound_at),
    inbound_count = c.inbound_count + excluded.inbound_count,
    outbound_count = c.outbound_count + excluded.outbound_count,
    unread_count = c.unread_count + excluded.unread_count,
    created_at = least(c.created_at, excluded.created_at),
    archived_at = CASE WHEN excluded.unread_count > 0 THEN NULL ELSE c.archived_at END;
  RETURN NULL;
END
$$;
