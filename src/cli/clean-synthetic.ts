import { pool } from '../db.js';

/* Removes fabricated geography, once the real register has been loaded.
 *
 *   npm run clean:synthetic              # dry run - shows what WOULD go
 *   npm run clean:synthetic -- --commit
 *
 * WHAT THIS IS FOR, AND WHY IT IS A SEPARATE COMMAND.
 *
 * The Gauteng demo set invented ward identifiers for the six local
 * municipalities: synthetic Emfuleni ward 1 is '42100001', built from the
 * MDB code GT421 plus a sequence. The real IEC ward is '74201001'. The three
 * metros happened to use real identifiers, so they merged cleanly when the
 * national register loaded - but Emfuleni, Midvaal, Lesedi, Mogale City,
 * Merafong City and Rand West City now appear twice, once fabricated and
 * once real, and the fabricated rows rank in mv_campaign_extract alongside
 * the real ones.
 *
 * That is 169 wards and 1,080 voting stations that do not exist. On 4 November
 * they would sit in the exception list all day as booths nobody can reach,
 * because there is nothing there to reach.
 *
 * It is a separate, explicitly-invoked, dry-run-by-default command rather
 * than a migration because deleting someone's data is not a thing to do as a
 * side effect of running migrations. Re-seeding restores it
 * (`npm run seed`), so this is reversible - but only deliberately.
 *
 * THE PREDICATE is narrow on purpose: source = 'SYNTHETIC' and delimitation
 * IS NULL. A ward the national loader has confirmed carries
 * delimitation='2026' and is never touched here, even if its voter count is
 * still synthetic - geography and roll have separate provenance for exactly
 * this reason.
 */

const commit = process.argv.includes('--commit');

// Delete order matters: children before parents, and booth_report before the
// stations it points at. Every one of these is restricted on delete (no
// cascade), so the order is the thing that makes this work at all.
const STEPS: Array<{ label: string; sql: string }> = [
  { label: 'booth reports (via station)', sql:
    `DELETE FROM booth_report WHERE station_id IN (
       SELECT s.station_id FROM station s JOIN ward w USING (ward_id)
        WHERE w.source = 'SYNTHETIC' AND w.delimitation IS NULL)` },
  { label: 'roster entries (via station)', sql:
    `UPDATE reporter_roster SET station_id = NULL WHERE station_id IN (
       SELECT s.station_id FROM station s JOIN ward w USING (ward_id)
        WHERE w.source = 'SYNTHETIC' AND w.delimitation IS NULL)` },
  { label: 'stations',       sql: byWard('station') },
  { label: 'issue signals',  sql: byWard('issue_signal') },
  { label: 'ward issues',    sql: byWard('ward_issue') },
  { label: 'deployments',    sql: byWard('deployment') },
  { label: 'call log',       sql: byWard('call_log') },
  { label: 'service outages', sql: byWard('service_outage') },
  { label: 'document links', sql: byWard('document_ward') },
  { label: 'decisions',      sql: byWard('decision') },
  { label: 'iec results',    sql: byWard('iec_result') },
  { label: 'locations',      sql: byWard('location') },
  { label: 'wards',          sql:
    `DELETE FROM ward WHERE source = 'SYNTHETIC' AND delimitation IS NULL` },
];

function byWard(table: string): string {
  return `DELETE FROM ${table} WHERE ward_id IN (
            SELECT ward_id FROM ward
             WHERE source = 'SYNTHETIC' AND delimitation IS NULL)`;
}

const { rows: targets } = await pool.query<{
  municipality: string; wards: number; stations: number;
}>(
  `SELECT w.municipality,
          count(DISTINCT w.ward_id)::int   AS wards,
          count(DISTINCT s.station_id)::int AS stations
     FROM ward w
     LEFT JOIN station s ON s.ward_id = w.ward_id
    WHERE w.source = 'SYNTHETIC' AND w.delimitation IS NULL
    GROUP BY w.municipality
    ORDER BY 2 DESC`);

if (targets.length === 0) {
  console.log('Nothing to clean: no fabricated wards remain.');
  await pool.end();
  process.exit(0);
}

// Refuse to run before the replacement exists. Deleting the demo set on a
// database where the real register has not loaded would leave those
// municipalities with no wards at all, which is worse than duplicates.
const { rows: check } = await pool.query<{ real_wards: number }>(
  `SELECT count(*)::int AS real_wards FROM ward WHERE delimitation = '2026'`);
const realWards = check[0]?.real_wards ?? 0;

if (realWards < 500) {
  // The list is NOT trustworthy yet, so it is not printed as though it were.
  //
  // The predicate is "synthetic geography that the register has not
  // confirmed". Before sources:register runs, nothing has been confirmed, so
  // every synthetic ward matches - including the ~354 Gauteng wards whose
  // ids are real and which the loader will adopt rather than replace.
  // Printing them under the heading "fabricated" would be a confident wrong
  // answer, and the sort of thing somebody acts on at 23:00.
  console.error(`Cannot tell yet which wards are fabricated.`);
  console.error(`\n${targets.reduce((n, t) => n + t.wards, 0)} wards are synthetic and `
    + `unconfirmed, but only ${realWards} real 2026 wards are loaded.`);
  console.error('Many of those synthetic wards carry real IEC identifiers and will be');
  console.error('adopted by the register rather than deleted - in Gauteng the three');
  console.error('metros were, and only the six local municipalities were invented.');
  console.error('\nRun this first, then come back:');
  console.error('  npm run build && npm run migrate && npm run sources:register');
  await pool.end();
  process.exit(1);
}

console.log(`Fabricated geography — synthetic wards the register did not confirm:\n`);
console.table(targets);
console.log(`Real 2026 wards loaded: ${realWards}`);

if (!commit) {
  console.log('\nDry run. Nothing deleted.');
  console.log('Re-run with --commit to apply. `npm run seed` restores the demo set.');
  await pool.end();
  process.exit(0);
}

const client = await pool.connect();
try {
  await client.query('BEGIN');
  // Append-only guards exist on booth_report; this is the sanctioned removal
  // of demo rows, so the trigger is stepped around for this transaction only
  // and restored by the COMMIT regardless of outcome.
  await client.query('SET LOCAL session_replication_role = replica');

  for (const step of STEPS) {
    const result = await client.query(step.sql);
    console.log(`  ${String(result.rowCount ?? 0).padStart(6)}  ${step.label}`);
  }

  await client.query('COMMIT');
  console.log('\nCleaned.');
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(`\nfailed, nothing deleted — ${(error as Error).message}`);
  client.release();
  await pool.end();
  process.exit(1);
} finally {
  client.release();
}

await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_campaign_extract');
const { rows } = await pool.query('SELECT * FROM v_register_coverage');
console.table(rows);

await pool.end();
process.exit(0);
