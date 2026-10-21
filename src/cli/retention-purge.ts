import { pool } from '../db.js';

/* Deletes personal data that has reached its retention date.
 *
 *   npm run retention:purge
 *   npm run retention:purge -- --dry-run
 *
 * A retention_until column that nothing ever acts on is not a retention
 * policy, it is a date in a table. This is the thing that makes it one.
 *
 * WHAT IS DELETED. The marshal's phone number, not the report. A booth
 * report is operational history - how long the queue was at 09:00 in
 * Katlehong - and that stays. The contact detail is the part with an
 * expiry, so the row is kept and the number is cleared.
 *
 * This is why booth_report's delete trigger refuses row deletion while
 * retention_until is in the future: the only sanctioned way to lose a
 * report is time, and even then the report survives and the phone does not.
 */

const dryRun = process.argv.includes('--dry-run');

const { rows: due } = await pool.query<{ n: number; oldest: string }>(
  `SELECT count(*)::int AS n, min(retention_until)::text AS oldest
     FROM booth_report
    WHERE reporter_phone IS NOT NULL AND retention_until <= CURRENT_DATE`);

const count = due[0]?.n ?? 0;
if (count === 0) {
  console.log('retention: nothing due');
} else if (dryRun) {
  console.log(`retention: ${count} contact numbers due (oldest ${due[0]?.oldest}) — dry run, nothing cleared`);
} else {
  // UPDATE, not DELETE: the report is operational history and stays. The
  // append-only trigger permits exactly this statement - expired row, phone
  // cleared, every other column identical - and refuses anything else, so
  // nothing has to be switched off to run it.
  try {
    const result = await pool.query(
      `UPDATE booth_report SET reporter_phone = NULL
        WHERE reporter_phone IS NOT NULL AND retention_until <= CURRENT_DATE`);
    console.log(`retention: cleared ${result.rowCount} expired contact numbers`);
  } catch (error) {
    console.error(`retention: failed — ${(error as Error).message}`);
    await pool.end();
    process.exit(1);
  }
}

/* Sessions expire on their own schedule in the API process, but the daily
 * job runs on a machine that may be the only thing awake, so it is swept
 * here too. Cheap, and it means an idle weekend does not leave live
 * sessions lying about. */
const sessions = await pool.query('DELETE FROM session WHERE expires_at < now()');
if ((sessions.rowCount ?? 0) > 0) {
  console.log(`retention: purged ${sessions.rowCount} expired sessions`);
}

await pool.end();
process.exit(0);
