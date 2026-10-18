import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pool } from '../db.js';

/* Loads the demonstration data.
 *
 *   npm run seed
 *   npm run seed -- --only 003,004
 *
 * SEPARATE FROM migrate ON PURPOSE. Schema is something you always want;
 * synthetic wards and invented sentiment are something you want only until
 * real data arrives, and a migrator that quietly inserts made-up rows is a
 * migrator nobody can trust. So this is its own command, run deliberately.
 *
 * That separation is also what went wrong: `npm run migrate` created the
 * sentiment tables and the sentiment screen then showed nothing, because the
 * rows live in db/test and were never loaded. The screen now says so itself,
 * but the command to fix it has to exist.
 *
 * The seeds guard themselves - 003 refuses to run over real IEC data, 004
 * refuses to run before 003 - so this runner does not duplicate those
 * checks. It runs them in order, in one transaction each, and reports what
 * each one said.
 */

const only = (() => {
  const i = process.argv.indexOf('--only');
  if (i === -1) return null;
  return new Set((process.argv[i + 1] ?? '').split(',').map((s) => s.trim()));
})();

const files = (await readdir('db/test').catch(() => [] as string[]))
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .filter((f) => !only || only.has(f.slice(0, 3)));

if (files.length === 0) {
  console.error(only
    ? 'No seed matches --only. Seeds are numbered 001 to 004.'
    : 'No seeds found. Run this from the repository root.');
  await pool.end();
  process.exit(1);
}

// 001 is a three-ward fixture for checking the arithmetic by hand against
// EXPECTED.md; loading it alongside the 523-ward demo mixes two datasets in
// one table. Skipped unless asked for by name.
const toRun = only ? files : files.filter((f) => !f.startsWith('001'));

console.log(`Seeding from db/test: ${toRun.map((f) => f.slice(0, 3)).join(', ')}`);

let loaded = 0;
let failed = 0;
for (const name of toRun) {
  const sql = await readFile(join('db/test', name), 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
    console.log(`  loaded ${name}`);
    loaded += 1;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    const code = (error as { code?: string }).code;
    const message = (error as Error).message;

    // A re-run is the normal case, and "duplicate key value violates unique
    // constraint ward_pkey" is not a sentence anyone should have to read to
    // learn that. A seed's own guard firing is likewise information: it
    // means something earlier has not been loaded, or real data is present.
    if (code === '23505') {
      console.log(`  skipped ${name} (already loaded)`);
    } else if (/Load \d{3}_/.test(message) || /Refusing/.test(message)) {
      console.log(`  skipped ${name} — ${message}`);
    } else {
      console.error(`  FAILED ${name}: ${message}`);
      failed += 1;
    }
  } finally {
    client.release();
  }
}

// The extract is computed from all of this, so it is stale until refreshed.
if (loaded > 0) {
  await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_campaign_extract');
}

const counts = await pool.query<{ label: string; n: string }>(`
  SELECT 'wards' AS label, count(*)::text AS n FROM ward
  UNION ALL SELECT 'grievances', count(*)::text FROM ward_issue
  UNION ALL SELECT 'sentiment signals', count(*)::text FROM issue_signal
  UNION ALL SELECT 'documents', count(*)::text FROM document
  UNION ALL SELECT 'decisions', count(*)::text FROM decision`);
console.log('\nIn the database now:');
for (const row of counts.rows) console.log(`  ${row.n.padStart(7)}  ${row.label}`);

await pool.end();
// A seed that genuinely failed should not look like a success.
process.exit(failed > 0 ? 1 : 0);
