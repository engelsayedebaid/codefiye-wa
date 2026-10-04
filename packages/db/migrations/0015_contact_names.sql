CREATE TABLE "contact_names" (
	"session_id" uuid NOT NULL,
	"jid" text NOT NULL,
	"saved_name" text,
	"verified_name" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_names_session_id_jid_pk" PRIMARY KEY("session_id","jid")
);
--> statement-breakpoint
ALTER TABLE "contact_names" ADD CONSTRAINT "contact_names_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- A name worth showing: not blank, not a masked number (`+20∙∙∙∙16`, given for LID chats in some
-- history syncs), not just a phone number.
CREATE OR REPLACE FUNCTION usable_contact_name(name text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT name IS NOT NULL AND btrim(name) <> '' AND name !~ '[∙•]' AND name !~ '^[+0-9 ().-]+$'
$$;
--> statement-breakpoint
-- What a chat is called: for a contact, the name saved on the phone, else a business's verified name,
-- else their own WhatsApp name (`chats.name`, from their messages); looked up under both of the
-- chat's addresses. A group keeps its subject exactly as before.
CREATE OR REPLACE FUNCTION chat_display_name(p_session uuid, p_jid text, p_alt text, p_name text) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN p_jid LIKE '%@g.us' THEN p_name ELSE coalesce(
    (SELECT coalesce(n.saved_name, n.verified_name) FROM contact_names n
     WHERE n.session_id = p_session AND n.jid IN (p_jid, p_alt) AND coalesce(n.saved_name, n.verified_name) IS NOT NULL
     ORDER BY (n.saved_name IS NOT NULL) DESC, (n.jid = p_jid) DESC LIMIT 1),
    CASE WHEN usable_contact_name(p_name) THEN p_name END) END
$$;
--> statement-breakpoint
-- The chat a message belongs to, as the chats trigger files it (LID → phone number via contact_lids).
CREATE OR REPLACE FUNCTION chat_jid_for(p_session uuid, p_direction text, p_remote text, p_content jsonb) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN p_remote LIKE '%@lid' THEN coalesce(
    (SELECT pn FROM contact_lids WHERE session_id = p_session AND lid = wa_user_jid(p_remote)),
    chat_jid_of(p_direction, p_remote, p_content)) ELSE p_remote END
$$;
--> statement-breakpoint
UPDATE chats SET name = NULL WHERE jid NOT LIKE '%@g.us' AND name IS NOT NULL AND NOT usable_contact_name(name);
