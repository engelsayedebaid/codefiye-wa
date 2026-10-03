/**
 * Creates (or reuses) a user, creates a workspace and prints a workspace access token.
 * Stand-in for signup until the CodeFiye auth module is ported (README §16).
 *
 *   pnpm bootstrap owner@example.com "Acme" [planId]
 */
import { apiKeys, createDb, databaseUrls, runMigrations, users, workspaces } from '@wa/db';
import { PLANS, TRIAL_DAYS } from '@wa/shared';
import { generateKey } from '../apps/api/src/lib/keys';

const [email = 'owner@example.com', name = 'My workspace', planId = 'trial'] = process.argv.slice(2);
if (!(planId in PLANS)) {
  console.error(`Unknown plan "${planId}". Use one of: ${Object.keys(PLANS).join(', ')}`);
  process.exit(1);
}

await runMigrations();
const { db, end } = createDb(databaseUrls().pooled, { max: 1 });

const [user] = await db
  .insert(users)
  .values({ email: email.toLowerCase() })
  .onConflictDoUpdate({ target: users.email, set: { email: email.toLowerCase() } })
  .returning();
const [workspace] = await db
  .insert(workspaces)
  .values({
    ownerId: user!.id,
    name,
    planId,
    trialEndsAt: planId === 'trial' ? new Date(Date.now() + TRIAL_DAYS * 86_400_000) : null,
  })
  .returning();
const token = generateKey('pat');
await db.insert(apiKeys).values({ workspaceId: workspace!.id, name: 'Bootstrap token', keyHash: token.hash, prefix: token.prefix });
await end();

console.log(`
Workspace "${workspace!.name}" (${workspace!.id}) on plan ${planId}
Owner: ${user!.email}

Workspace access token (shown once — store it now):
  ${token.key}

Try it:
  curl -H "Authorization: Bearer ${token.key}" http://localhost:4000/api/whatsapp-sessions
`);
