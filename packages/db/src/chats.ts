import type { Sql } from './client';

/**
 * Marks a conversation read (`chats.unread_count` = 0). `jid` may be either address of the contact
 * (phone number or LID). Returns the chat's JID when something changed, so callers notify only then.
 */
export async function markChatRead(sql: Sql, sessionId: string, jid: string): Promise<string | null> {
  const [row] = await sql<{ jid: string }[]>`
    update chats set unread_count = 0
    where session_id = ${sessionId} and (jid = ${jid} or alt_jid = ${jid}) and unread_count > 0
    returning jid`;
  return row?.jid ?? null;
}

const LID_BATCH = 500;

/**
 * Records LID → phone-number pairs (`…@lid` → `…@s.whatsapp.net`) for a session. Each new pair
 * merges the LID's chat into the number's (trigger, migration 0013). Takes the session's chat lock
 * first, as the chats trigger does, so the two never wait on each other in opposite orders.
 * Returns how many pairs were new.
 */
export async function recordLidMappings(sql: Sql, sessionId: string, pairs: { lid: string; pn: string }[]): Promise<number> {
  let added = 0;
  for (let i = 0; i < pairs.length; i += LID_BATCH) {
    const batch = pairs.slice(i, i + LID_BATCH);
    added += await sql.begin(async (tx) => {
      await tx`select chat_lock(${sessionId})`;
      const rows = await tx`
        insert into contact_lids (session_id, lid, pn)
        select ${sessionId}, wa_user_jid(p.lid), wa_user_jid(p.pn)
        from unnest(${batch.map((p) => p.lid)}::text[], ${batch.map((p) => p.pn)}::text[]) as p(lid, pn)
        where p.lid like '%@lid' and p.pn like '%@s.whatsapp.net'
        on conflict do nothing
        returning lid`;
      return rows.length;
    });
  }
  return added;
}

/**
 * Stores contact names (saved in the phone's address book, or a business's verified name) by address.
 * A later name replaces an earlier one; a missing one never erases what we have. Names don't create
 * chats: a chat shows the name found under either of its addresses (`chat_display_name`).
 * Returns how many contacts changed.
 */
export async function recordContactNames(sql: Sql, sessionId: string, contacts: { jid: string; savedName?: string; verifiedName?: string }[]): Promise<number> {
  // One row per address (an upsert can't touch the same row twice in a statement): later entries win.
  const merged = new Map<string, { saved: string | null; verified: string | null }>();
  for (const c of contacts) {
    const prev = merged.get(c.jid);
    merged.set(c.jid, { saved: c.savedName ?? prev?.saved ?? null, verified: c.verifiedName ?? prev?.verified ?? null });
  }
  const rows = [...merged].filter(([, n]) => n.saved || n.verified);
  let changed = 0;
  for (let i = 0; i < rows.length; i += LID_BATCH) {
    const batch = rows.slice(i, i + LID_BATCH);
    const updated = await sql`
      insert into contact_names as n (session_id, jid, saved_name, verified_name)
      select ${sessionId}, x.jid, x.saved, x.verified
      from unnest(${batch.map(([jid]) => jid)}::text[], ${batch.map(([, n]) => n.saved)}::text[], ${batch.map(([, n]) => n.verified)}::text[]) as x(jid, saved, verified)
      on conflict (session_id, jid) do update set
        saved_name = coalesce(excluded.saved_name, n.saved_name),
        verified_name = coalesce(excluded.verified_name, n.verified_name),
        updated_at = now()
      where n.saved_name is distinct from coalesce(excluded.saved_name, n.saved_name)
        or n.verified_name is distinct from coalesce(excluded.verified_name, n.verified_name)
      returning 1`;
    changed += updated.length;
  }
  return changed;
}

/** Keeps a group's subject on its chat row (the trigger only knows contacts' names). */
export async function setChatName(sql: Sql, sessionId: string, jid: string, name: string) {
  await sql`update chats set name = ${name} where session_id = ${sessionId} and jid = ${jid} and name is distinct from ${name}`;
}

/** A file attached on the chats page (`upload:<id>` in outbound content); null once pruned. */
export async function loadUpload(sql: Sql, id: string): Promise<{ data: Buffer; mimetype: string; fileName: string | null } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [row] = await sql<{ data: Buffer; mimetype: string; file_name: string | null }[]>`
    select data, mimetype, file_name from media_uploads where id = ${id}`;
  return row ? { data: row.data, mimetype: row.mimetype, fileName: row.file_name } : null;
}
