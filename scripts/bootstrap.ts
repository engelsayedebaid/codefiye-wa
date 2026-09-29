// Creates a workspace + workspace token (PAT) until the real signup flow (CodeFiye auth) is ported.
// Usage: pnpm bootstrap [email] [workspace-name]
import { apiKeys, createDb, users, workspaces } from '@wa/db';
import { generateApiKey } from '../apps/api/src/lib/keys';

const [email = 'owner@example.com', name = 'Default workspace'] = process.argv.slice(2);
const db = createDb();

try {
  const [user] = await db.insert(users).values({ email }).onConflictDoUpdate({ target: users.email, set: { email } }).returning();
  const [ws] = await db
    .insert(workspaces)
    .values({ name, ownerId: user!.id, trialEndsAt: new Date(Date.now() + 3 * 86_400_000) })
    .returning();
  const { key, keyHash, prefix } = generateApiKey('pat');
  await db.insert(apiKeys).values({ workspaceId: ws!.id, name: 'bootstrap', keyHash, prefix, scopes: ['*'] });

  console.log(`\nWorkspace: ${ws!.name} (${ws!.id})`);
  console.log(`Owner:     ${email}`);
  console.log(`\nWorkspace token (shown once — store it now):\n\n  ${key}\n`);
} finally {
  await db.close();
}
