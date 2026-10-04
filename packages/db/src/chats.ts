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
