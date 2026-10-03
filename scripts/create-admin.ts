/**
 * Creates (or promotes) a platform admin (`users.role = admin`, active), and a workspace on the internal
 * `unlimited` plan with no expiry. Prints a generated password for new users, or with
 * `--reset-password`; set ADMIN_PASSWORD to choose it instead.
 *
 *   pnpm admin:create admin@example.com "Admin name" [--reset-password]
 */
import { randomBytes } from 'node:crypto';
import { createDb, databaseUrls, eq, runMigrations, users, workspaces } from '@wa/db';
import { PLANS } from '@wa/shared';
import { hashPassword } from '../apps/api/src/lib/passwords';

const args = process.argv.slice(2);
const resetPassword = args.includes('--reset-password');
const [rawEmail, name = 'Admin'] = args.filter((a) => !a.startsWith('--'));
if (!rawEmail?.includes('@')) {
  console.error('Usage: pnpm admin:create <email> ["Name"] [--reset-password]');
  process.exit(1);
}
const email = rawEmail.toLowerCase();

await runMigrations();
const { db, end } = createDb(databaseUrls().pooled, { max: 1 });

const [existing] = await db.select().from(users).where(eq(users.email, email));
const password = !existing || resetPassword || !existing.passwordHash ? (process.env.ADMIN_PASSWORD ?? randomBytes(12).toString('base64url')) : null;
const passwordHash = password ? await hashPassword(password) : undefined;

const [user] = existing
  ? await db
      .update(users)
      .set({ role: 'admin', status: 'active', suspendedAt: null, suspendedReason: null, ...(passwordHash ? { passwordHash } : {}) })
      .where(eq(users.id, existing.id))
      .returning()
  : await db.insert(users).values({ email, name, passwordHash, role: 'admin' }).returning();

const plan = { planId: PLANS.unlimited.id, trialEndsAt: null, planExpiresAt: null };
const [owned] = await db.select().from(workspaces).where(eq(workspaces.ownerId, user!.id)).orderBy(workspaces.createdAt).limit(1);
const [workspace] = owned
  ? await db.update(workspaces).set(plan).where(eq(workspaces.id, owned.id)).returning()
  : await db
      .insert(workspaces)
      .values({ ownerId: user!.id, name: user!.name ?? name, ...plan })
      .returning();
await end();

console.log(`
Admin ready: ${user!.email}
Workspace "${workspace!.name}" (${workspace!.id}) on the ${PLANS.unlimited.name} plan, no expiry.
${password ? `\nPassword (shown once — store it now, then change it):\n  ${password}\n` : '\nPassword unchanged (pass --reset-password to generate a new one).\n'}
Log in at /login, then open /admin.
`);
