/**
 * Create or reset an API user.
 *
 *   node --env-file=.env dist/cli/create-user.js <email> <name> <role>
 *
 * Generates a password, prints it once, and stores only the scrypt hash.
 * Nothing writes the password to a file or a log.
 */
import { randomBytes } from 'node:crypto';
import { pool } from '../db.js';
import { hashPassword } from '../api/auth.js';

const ROLES = ['viewer', 'reporter', 'treasurer', 'admin'];

async function main(): Promise<void> {
  const [email, displayName, role = 'viewer'] = process.argv.slice(2);
  if (!email || !displayName) {
    throw new Error('usage: create-user <email> <display name> [role]');
  }
  if (!ROLES.includes(role)) throw new Error(`role must be one of: ${ROLES.join(', ')}`);

  const password = randomBytes(12).toString('base64url');
  const passwordHash = await hashPassword(password);
  const userId = email.split('@')[0]?.slice(0, 40) ?? randomBytes(6).toString('hex');

  await pool.query(
    `INSERT INTO app_user (user_id, email, display_name, role, password_hash)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (user_id) DO UPDATE SET
       email = EXCLUDED.email, display_name = EXCLUDED.display_name,
       role = EXCLUDED.role, password_hash = EXCLUDED.password_hash,
       is_active = true`,
    [userId, email, displayName, role, passwordHash],
  );

  console.log(`user_id : ${userId}`);
  console.log(`role    : ${role}`);
  console.log(`password: ${password}`);
  console.log('\nShown once. It is not stored anywhere in readable form.');
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; })
      .finally(() => pool.end());
