-- One conversation per contact. WhatsApp addresses a contact by phone number (`…@s.whatsapp.net`)
-- or by LID (`…@lid`, a privacy id), and Baileys only sometimes says which number a LID is. Chats
-- used to be keyed by whatever address a message came with, so one person could get two chats: one
-- under the LID (no number) and one under the number. Now `contact_lids` records every LID → number
-- pair we learn, the chats trigger files LID messages under the number, and learning a pair merges
-- the LID's chat into the number's. Messages are never rewritten: a chat reads its history under
-- both `jid` and `alt_jid`, so nothing moves and nothing can be lost.
CREATE TABLE "contact_lids" (
	"session_id" uuid NOT NULL,
	"lid" text NOT NULL,
	"pn" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_lids_session_id_lid_pk" PRIMARY KEY("session_id","lid")
);
--> statement-breakpoint
ALTER TABLE "contact_lids" ADD CONSTRAINT "contact_lids_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contact_lids_session_id_pn_index" ON "contact_lids" USING btree ("session_id","pn");--> statement-breakpoint
-- Every write that creates, renames or merges a session's chats holds this lock (re-entrant within a
-- transaction), so a message and a newly learnt pair for the same contact can't each make a chat.
CREATE OR REPLACE FUNCTION chat_lock(session uuid) RETURNS void
LANGUAGE sql AS $$ SELECT pg_advisory_xact_lock(hashtextextended('chats:' || session::text, 0)) $$;
--> statement-breakpoint
-- `2010…:12@s.whatsapp.net` (a device) → `2010…@s.whatsapp.net`.
CREATE OR REPLACE FUNCTION wa_user_jid(jid text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$ SELECT regexp_replace(jid, ':[0-9]+@', '@') $$;
--> statement-breakpoint
-- Folds the LID's chat into the phone number's (or renames it when the number has none). Skips a
-- number already tied to another LID rather than guess which person is which.
CREATE OR REPLACE FUNCTION merge_lid_chat(p_session uuid, p_lid text, p_pn text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  l chats%ROWTYPE;
  p chats%ROWTYPE;
BEGIN
  PERFORM chat_lock(p_session);
  SELECT * INTO p FROM chats WHERE session_id = p_session AND jid = p_pn FOR UPDATE;
  IF FOUND AND p.alt_jid IS NOT NULL AND p.alt_jid <> p_lid THEN
    RETURN;
  END IF;
  SELECT * INTO l FROM chats WHERE session_id = p_session AND jid = p_lid FOR UPDATE;
  IF NOT FOUND THEN
    -- No LID chat: just remember the LID on the number's chat (for its history and lookups).
    UPDATE chats SET alt_jid = p_lid
    WHERE session_id = p_session AND jid = p_pn AND alt_jid IS NULL
      AND NOT EXISTS (SELECT 1 FROM chats x WHERE x.session_id = p_session AND x.alt_jid = p_lid);
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM chats x WHERE x.session_id = p_session AND x.alt_jid = p_lid AND x.jid <> p_pn) THEN
    RETURN; -- the LID already belongs to another number's chat: leave both alone
  END IF;
  IF p.jid IS NULL THEN
    UPDATE chats SET jid = p_pn, alt_jid = p_lid WHERE session_id = p_session AND jid = p_lid;
    RETURN;
  END IF;
  DELETE FROM chats WHERE session_id = p_session AND jid = p_lid;
  UPDATE chats c SET
    alt_jid = p_lid,
    name = coalesce(c.name, l.name),
    last_message_id = CASE WHEN l.last_message_at > c.last_message_at THEN l.last_message_id ELSE c.last_message_id END,
    last_message_at = greatest(c.last_message_at, l.last_message_at),
    last_inbound_at = greatest(c.last_inbound_at, l.last_inbound_at),
    last_outbound_at = greatest(c.last_outbound_at, l.last_outbound_at),
    inbound_count = c.inbound_count + l.inbound_count,
    outbound_count = c.outbound_count + l.outbound_count,
    unread_count = c.unread_count + l.unread_count,
    pinned_at = coalesce(c.pinned_at, l.pinned_at),
    -- Archived only if both were.
    archived_at = CASE WHEN c.archived_at IS NULL OR l.archived_at IS NULL THEN NULL ELSE greatest(c.archived_at, l.archived_at) END,
    created_at = least(c.created_at, l.created_at)
  WHERE c.session_id = p_session AND c.jid = p_pn;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION contact_lids_merge() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM merge_lid_chat(NEW.session_id, NEW.lid, NEW.pn);
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER contact_lids_merge AFTER INSERT ON contact_lids
FOR EACH ROW EXECUTE FUNCTION contact_lids_merge();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION chats_on_messages() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Lock first (sessions in a fixed order), then read the pairs: anything learnt by a transaction
  -- that held the lock before us is visible to the statements below.
  PERFORM chat_lock(s.session_id) FROM (SELECT DISTINCT session_id FROM new_messages ORDER BY session_id) s;

  -- An inbound LID message that names the sender's number teaches us the pair (and merges).
  INSERT INTO contact_lids (session_id, lid, pn)
  SELECT DISTINCT n.session_id, wa_user_jid(n.remote_jid), wa_user_jid(n.content->>'from')
  FROM new_messages n
  WHERE n.direction = 'in' AND n.remote_jid LIKE '%@lid' AND n.content->>'from' LIKE '%@s.whatsapp.net'
  ON CONFLICT DO NOTHING;

  INSERT INTO chats AS c (session_id, jid, workspace_id, alt_jid, name, last_message_id, last_message_at,
                          last_inbound_at, last_outbound_at, inbound_count, outbound_count, unread_count, created_at)
  SELECT m.session_id, m.chat_jid, m.workspace_id,
         -- Never a LID another chat holds (the unique index would fail the message insert).
         CASE WHEN NOT EXISTS (SELECT 1 FROM chats x WHERE x.session_id = m.session_id AND x.alt_jid = max(m.alt_jid) AND x.jid <> m.chat_jid)
           THEN max(m.alt_jid) END,
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
           coalesce(cl.pn, n.remote_jid) AS chat_jid,
           -- The chat's LID: the address this message came under, or the one known for its number.
           CASE
             WHEN cl.pn IS NOT NULL THEN wa_user_jid(n.remote_jid)
             WHEN n.remote_jid LIKE '%@s.whatsapp.net' THEN
               (SELECT r.lid FROM contact_lids r WHERE r.session_id = n.session_id AND r.pn = n.remote_jid ORDER BY r.created_at DESC LIMIT 1)
           END AS alt_jid,
           CASE WHEN n.direction = 'in' AND n.remote_jid NOT LIKE '%@g.us' THEN nullif(n.content->>'pushName', '') END AS push_name,
           coalesce((n.content->>'history')::boolean, false) AS history
    FROM new_messages n
    LEFT JOIN contact_lids cl ON n.remote_jid LIKE '%@lid' AND cl.session_id = n.session_id AND cl.lid = wa_user_jid(n.remote_jid)
    WHERE n.type <> 'reaction'
  ) m
  GROUP BY m.session_id, m.chat_jid, m.workspace_id
  ORDER BY m.session_id, m.chat_jid
  ON CONFLICT (session_id, jid) DO UPDATE SET
    -- A chat keeps the LID it has.
    alt_jid = coalesce(c.alt_jid, excluded.alt_jid),
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
--> statement-breakpoint
-- Pairs already in the data (chats that know their LID, and messages carrying both addresses);
-- inserting them merges today's duplicate chats. The rest come from Baileys' encrypted mapping store,
-- which only a worker can read: each worker backfills its sessions when it starts them.
INSERT INTO contact_lids (session_id, lid, pn)
SELECT DISTINCT ON (session_id, lid) session_id, lid, pn FROM (
  SELECT session_id, wa_user_jid(alt_jid) AS lid, wa_user_jid(jid) AS pn, 0 AS rank
  FROM chats WHERE jid LIKE '%@s.whatsapp.net' AND alt_jid LIKE '%@lid'
  UNION ALL
  SELECT session_id, wa_user_jid(remote_jid), wa_user_jid(content->>'from'), 1
  FROM messages WHERE direction = 'in' AND remote_jid LIKE '%@lid' AND content->>'from' LIKE '%@s.whatsapp.net'
  UNION ALL
  SELECT session_id, wa_user_jid(remote_jid), wa_user_jid(raw->'key'->>'remoteJidAlt'), 2
  FROM messages WHERE remote_jid LIKE '%@lid' AND raw->'key'->>'remoteJidAlt' LIKE '%@s.whatsapp.net'
) pairs
ORDER BY session_id, lid, rank
ON CONFLICT DO NOTHING;
--> statement-breakpoint
DROP INDEX "chats_session_id_alt_jid_index";--> statement-breakpoint
CREATE UNIQUE INDEX "chats_session_id_alt_jid_index" ON "chats" USING btree ("session_id","alt_jid") WHERE "chats"."alt_jid" is not null;
