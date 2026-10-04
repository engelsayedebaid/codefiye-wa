CREATE TABLE "chats" (
	"session_id" uuid NOT NULL,
	"jid" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"alt_jid" text,
	"name" text,
	"last_message_id" bigint,
	"last_message_at" timestamp with time zone NOT NULL,
	"last_inbound_at" timestamp with time zone,
	"last_outbound_at" timestamp with time zone,
	"inbound_count" integer DEFAULT 0 NOT NULL,
	"outbound_count" integer DEFAULT 0 NOT NULL,
	"unread_count" integer DEFAULT 0 NOT NULL,
	"pinned_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chats_session_id_jid_pk" PRIMARY KEY("session_id","jid")
);
--> statement-breakpoint
CREATE TABLE "media_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"file_name" text,
	"mimetype" text NOT NULL,
	"size" integer NOT NULL,
	"data" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_uploads" ADD CONSTRAINT "media_uploads_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chats_session_id_last_message_at_index" ON "chats" USING btree ("session_id","last_message_at");--> statement-breakpoint
CREATE INDEX "chats_session_id_alt_jid_index" ON "chats" USING btree ("session_id","alt_jid") WHERE "chats"."alt_jid" is not null;--> statement-breakpoint
CREATE INDEX "media_uploads_created_at_index" ON "media_uploads" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "messages_chat_idx" ON "messages" USING btree ("session_id","remote_jid","id");--> statement-breakpoint
-- The conversation a message belongs to: an inbound 1:1 message addressed by LID is filed under the
-- sender's phone number when WhatsApp told us it (content.from), so it joins the chat our sends use.
CREATE FUNCTION chat_jid_of(direction text, remote_jid text, content jsonb) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN direction = 'in' AND remote_jid LIKE '%@lid' AND content->>'from' LIKE '%@s.whatsapp.net' THEN content->>'from'
    ELSE remote_jid
  END
$$;
--> statement-breakpoint
-- Keeps `chats` current for every statement that inserts messages (API sends, campaigns, inbound,
-- the phone). Rows are upserted in key order so concurrent multi-chat inserts can't deadlock.
-- Reactions aren't conversation messages: they don't move a chat.
CREATE FUNCTION chats_on_messages() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO chats AS c (session_id, jid, workspace_id, alt_jid, name, last_message_id, last_message_at,
                          last_inbound_at, last_outbound_at, inbound_count, outbound_count, unread_count)
  SELECT m.session_id, m.chat_jid, m.workspace_id,
         max(m.alt_jid),
         (array_agg(m.push_name ORDER BY m.id DESC) FILTER (WHERE m.push_name IS NOT NULL))[1],
         max(m.id), max(m.created_at),
         max(m.created_at) FILTER (WHERE m.direction = 'in'),
         max(m.created_at) FILTER (WHERE m.direction = 'out'),
         count(*) FILTER (WHERE m.direction = 'in'),
         count(*) FILTER (WHERE m.direction = 'out'),
         count(*) FILTER (WHERE m.direction = 'in')
  FROM (
    SELECT n.id, n.session_id, n.workspace_id, n.direction, n.created_at,
           chat_jid_of(n.direction, n.remote_jid, n.content) AS chat_jid,
           CASE WHEN chat_jid_of(n.direction, n.remote_jid, n.content) <> n.remote_jid THEN n.remote_jid END AS alt_jid,
           CASE WHEN n.direction = 'in' AND n.remote_jid NOT LIKE '%@g.us' THEN nullif(n.content->>'pushName', '') END AS push_name
    FROM new_messages n
    WHERE n.type <> 'reaction'
  ) m
  GROUP BY m.session_id, m.chat_jid, m.workspace_id
  ORDER BY m.session_id, m.chat_jid
  ON CONFLICT (session_id, jid) DO UPDATE SET
    alt_jid = coalesce(excluded.alt_jid, c.alt_jid),
    name = CASE WHEN c.jid LIKE '%@g.us' THEN c.name ELSE coalesce(excluded.name, c.name) END,
    last_message_id = greatest(c.last_message_id, excluded.last_message_id),
    last_message_at = greatest(c.last_message_at, excluded.last_message_at),
    last_inbound_at = greatest(c.last_inbound_at, excluded.last_inbound_at),
    last_outbound_at = greatest(c.last_outbound_at, excluded.last_outbound_at),
    inbound_count = c.inbound_count + excluded.inbound_count,
    outbound_count = c.outbound_count + excluded.outbound_count,
    unread_count = c.unread_count + excluded.unread_count,
    -- A new message from the contact brings an archived chat back, as on WhatsApp.
    archived_at = CASE WHEN excluded.inbound_count > 0 THEN NULL ELSE c.archived_at END;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER messages_chats AFTER INSERT ON messages
REFERENCING NEW TABLE AS new_messages
FOR EACH STATEMENT EXECUTE FUNCTION chats_on_messages();
--> statement-breakpoint
-- Existing conversations, all read.
INSERT INTO chats (session_id, jid, workspace_id, alt_jid, name, last_message_id, last_message_at,
                   last_inbound_at, last_outbound_at, inbound_count, outbound_count, unread_count, created_at)
SELECT m.session_id, m.chat_jid, m.workspace_id,
       max(m.alt_jid),
       (array_agg(m.push_name ORDER BY m.id DESC) FILTER (WHERE m.push_name IS NOT NULL))[1],
       max(m.id), max(m.created_at),
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
