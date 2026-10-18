import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pool } from '../db.js';

/* Applies the schema.
 *
 *   npm run migrate
 *   npm run migrate -- --dry-run
 *
 * WHY THIS EXISTS. Every setup instruction for this project so far has been
 * a psql command, and psql is not on the PATH of the machine this runs on -
 * the Postgres here is in a container and the client was never installed
 * beside it. So the migrations silently did not run, the code moved ahead of
 * the database, and the first symptom was a foreign key failing three steps
 * later. Node and pg are already dependencies and already reach the
 * database, so the schema should be applied the same way everything else
 * talks to it.
 *
 * WHAT IT DOES. db/migrations, then db/views, then db/extract, each in file
 * order, each file in its own transaction, each recorded in schema_migration
 * so a second run is a no-op. That order is the shape of the system: raw
 * tables, then the views computed from them, then the one materialised
 * extract the dashboard reads. db/test is NOT run - seeds are deliberate.
 *
 * RECONCILING A DATABASE THAT PRE-DATES THIS RUNNER. A file whose very first
 * statement fails because the object is already there was applied by hand
 * before tracking existed. That is recorded as 'present' rather than
 * 'applied' and the run continues - the distinction is kept because
 * "we ran this" and "this was already here, we assume correctly" are not the
 * same claim. Every other error stops the run with the file named.
 */

const DUPLICATE_CODES = new Set([
  '42P07', // duplicate_table (also views, indexes, matviews)
  '42710', // duplicate_object (types, constraints, enums)
  '42701', // duplicate_column
  '42723', // duplicate_function
  '42P06', // duplicate_schema
  '42P16', // invalid_table_definition, e.g. CREATE OR REPLACE VIEW changing columns
]);

const dryRun = process.argv.includes('--dry-run');

async function filesIn(dir: string): Promise<Array<{ path: string; name: string }>> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  return entries
    .filter((f) => f.endsWith('.sql'))
    // Lexical order is deliberate: the files are numbered, and a numeric
    // sort would disagree with the names once there are more than nine.
    .sort()
    .map((name) => ({ path: join(dir, name), name: `${dir.split('/').pop()}/${name}` }));
}

await pool.query(`
  CREATE TABLE IF NOT EXISTS schema_migration (
    filename   text PRIMARY KEY,
    sha256     text NOT NULL,
    status     text NOT NULL CHECK (status IN ('applied', 'present')),
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);

const done = new Map<string, { sha256: string; status: string }>();
for (const row of (await pool.query<{ filename: string; sha256: string; status: string }>(
  'SELECT filename, sha256, status FROM schema_migration')).rows) {
  done.set(row.filename, { sha256: row.sha256, status: row.status });
}

const files = [
  ...await filesIn('db/migrations'),
  ...await filesIn('db/views'),
  ...await filesIn('db/extract'),
];
if (files.length === 0) {
  console.error('No .sql files found. Run this from the repository root.');
  await pool.end();
  process.exit(1);
}

let applied = 0, present = 0, skipped = 0, changed = 0;

for (const file of files) {
  const sql = await readFile(file.path, 'utf8');
  const sha256 = createHash('sha256').update(sql).digest('hex');
  const seen = done.get(file.name);

  if (seen && seen.sha256 === sha256) { skipped += 1; continue; }
  if (seen && seen.sha256 !== sha256) {
    // Not re-applied automatically. Editing an applied migration in place is
    // how two databases quietly stop matching; the fix is a new file.
    console.warn(`  ~ ${file.name} has changed since it was applied — not re-run.`);
    console.warn('    Add a new migration rather than editing one that has shipped.');
    changed += 1;
    continue;
  }

  if (dryRun) { console.log(`  would apply ${file.name}`); applied += 1; continue; }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query(
      `INSERT INTO schema_migration (filename, sha256, status) VALUES ($1, $2, 'applied')`,
      [file.name, sha256]);
    await client.query('COMMIT');
    console.log(`  applied ${file.name}`);
    applied += 1;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    const code = (error as { code?: string }).code;

    if (code && DUPLICATE_CODES.has(code)) {
      await pool.query(
        `INSERT INTO schema_migration (filename, sha256, status) VALUES ($1, $2, 'present')
         ON CONFLICT (filename) DO NOTHING`,
        [file.name, sha256]);
      console.log(`  present ${file.name} (objects already existed; recorded, not re-run)`);
      present += 1;
    } else {
      console.error(`\nFailed on ${file.name}`);
      console.error(`  ${(error as Error).message}`);
      if (code) console.error(`  SQLSTATE ${code}`);
      console.error('\nNothing from this file was applied; the transaction rolled back.');
      client.release();
      await pool.end();
      process.exit(1);
    }
  } finally {
    client.release();
  }
}

console.log(
  `\n${dryRun ? 'Would apply' : 'Applied'} ${applied}, ` +
  `${present} already present, ${skipped} unchanged` +
  (changed ? `, ${changed} edited after shipping (left alone)` : ''));

/* Then check it. "Already present" is an inference from one duplicate error
 * on one statement, and a file that was half applied by hand would pass that
 * test while leaving later statements undone. So read back every relation
 * the SQL claims to create and confirm it is actually there. This is the
 * check that would have caught the schema drifting behind the code instead
 * of letting a foreign key report it three steps later. */
if (!dryRun) {
  const expected = new Map<string, string>();   // schema.name -> kind
  for (const file of files) {
    const sql = await readFile(file.path, 'utf8');
    // The optional first group is a schema prefix: migration 011 puts its
    // staging tables in a raw schema, and a name-only check looks for
    // "raw" in public and reports a table that was never meant to be there.
    const pattern = new RegExp(
      'create\\s+(?:or\\s+replace\\s+)?(table|view|materialized\\s+view|type|function)'
      + '\\s+(?:if\\s+not\\s+exists\\s+)?(?:([a-z_][a-z0-9_]*)\\.)?([a-z_][a-z0-9_]*)', 'gi');
    for (const match of sql.matchAll(pattern)) {
      const schema = (match[2] ?? 'public').toLowerCase();
      expected.set(`${schema}.${match[3]!.toLowerCase()}`,
        match[1]!.toLowerCase().replace(/\s+/g, ' '));
    }
  }

  const { rows: found } = await pool.query<{ qualified: string }>(`
    SELECT n.nspname || '.' || c.relname AS qualified FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
    UNION SELECT n.nspname || '.' || t.typname FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
    UNION SELECT n.nspname || '.' || p.proname FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')`);
  const have = new Set(found.map((r) => r.qualified));

  const missing = [...expected].filter(([name]) => !have.has(name));
  if (missing.length > 0) {
    console.error(`\n${missing.length} object(s) the migrations create are NOT in the database:`);
    for (const [name, kind] of missing) console.error(`  ${kind} ${name}`);
    console.error('\nA file was probably applied by hand and only partly took. '
      + 'Find which migration creates these and apply the rest of it.');
    await pool.end();
    process.exit(1);
  }
  console.log(`Verified ${expected.size} objects present.`);
}

await pool.end();
