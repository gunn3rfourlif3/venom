/* Council sizes from the IEC results dashboard.
 *
 *   npm run import:seats -- --dry-run
 *   npm run import:seats
 *
 * WHAT THIS UNBLOCKS. `council_seats.total_seats` was NULL for all 213
 * councils, and the seat engine refuses to project without it - correctly,
 * since section 22(2) of the Structures Act makes ward councillors 50% of
 * the total rounded up, so a council with w wards has either 2w or 2w-1
 * seats and the difference moves the quota. It cannot be derived.
 *
 * The IEC publishes it. Every party row in the results dashboard carries
 * AvailableSeats for its council, for all 213, with none missing. That is
 * the figure this loads.
 *
 * IT DOES NOT OVERWRITE A DISAGREEMENT QUIETLY. Where the IEC's council size
 * conflicts with what the ward register implies, the row is left alone and
 * the conflict is reported. Two sources disagreeing about the size of a
 * council is a finding, not a merge conflict to be resolved by whichever
 * ran last - and this project has been bitten more than once by the version
 * that writes last winning silently.
 */

import { pool, withTransaction } from '../db.js';
import {
  fetchNational, municipalitiesOf, availableSeats, EEID_2026, DASHBOARD_BASE,
} from '../iec/dashboard.js';

const dryRun = process.argv.includes('--dry-run');

interface Existing {
  demarcation_code: string;
  municipality: string;
  ward_seats: number;
  total_seats: number | null;
  source: string;
}

const main = async () => {
  process.stdout.write('Fetching the national results file… ');
  const national = await fetchNational();
  const all = municipalitiesOf(national);
  console.log(`${all.length} councils, as at ${national.ReportDate}`);

  /* Counting may still be running. Council size is structural and does not
     move as votes arrive, so this is safe to load mid-count - but say where
     the count stands, because someone reading "loaded from the IEC" will
     otherwise assume the results are final. */
  console.log(`  count progress: ${national.VDsComplete.toLocaleString('en-ZA')}`
    + ` of ${national.VDExpected.toLocaleString('en-ZA')} voting districts`
    + ` (${national.Perc_VDsComplete}%), `
    + `${national.MuncipalitiesComplete} of ${national.MunicExpected} councils complete\n`);

  const existing = new Map<string, Existing>();
  const rows = await pool.query<Existing>(
    `SELECT cs.demarcation_code, m.name AS municipality,
            cs.ward_seats, cs.total_seats, cs.source
       FROM council_seats cs
       JOIN municipality m ON m.demarcation_code = cs.demarcation_code`);
  for (const r of rows.rows) existing.set(r.demarcation_code, r);

  const toWrite: Array<{ code: string; total: number; ward: number; pr: number }> = [];
  const conflicts: string[] = [];
  const unmatched: string[] = [];
  const unchanged: string[] = [];

  for (const m of all) {
    let total: number | null;
    try {
      total = availableSeats(m);
    } catch (error) {
      conflicts.push(`${m.code}: ${(error as Error).message}`);
      continue;
    }
    if (total === null) { conflicts.push(`${m.code}: no council size published`); continue; }

    const have = existing.get(m.code);
    if (!have) {
      /* The IEC knows a council this register does not. Worth reporting
         rather than inserting: a municipality missing from our register is a
         gap in the register, and inserting a seats row for a municipality
         that does not exist would fail the foreign key anyway. */
      unmatched.push(`${m.code} — ${m.name} (${m.Province})`);
      continue;
    }

    const pr = total - have.ward_seats;
    if (pr < 0) {
      conflicts.push(
        `${m.code} ${have.municipality}: IEC says ${total} seats but our `
        + `register has ${have.ward_seats} wards, which would leave ${pr} PR `
        + 'seats. One of the two is wrong — not writing either.');
      continue;
    }
    /* s22(2): wards are half the council rounded up, so total is 2w or 2w-1.
       Anything else means the register and the IEC disagree about the ward
       count, which matters well beyond this table. */
    if (total !== have.ward_seats * 2 && total !== have.ward_seats * 2 - 1) {
      conflicts.push(
        `${m.code} ${have.municipality}: IEC says ${total} seats, but `
        + `${have.ward_seats} wards implies ${have.ward_seats * 2 - 1} or `
        + `${have.ward_seats * 2} under s22(2). Register and IEC disagree.`);
      continue;
    }
    if (have.total_seats === total && have.source !== 'DERIVED_WARD_COUNT') {
      unchanged.push(m.code);
      continue;
    }
    toWrite.push({ code: m.code, total, ward: have.ward_seats, pr });
  }

  console.log(`  ${toWrite.length} to write`);
  if (unchanged.length) console.log(`  ${unchanged.length} already confirmed and unchanged`);
  if (unmatched.length) {
    console.log(`\n  ${unmatched.length} council(s) the IEC lists and our register does not:`);
    for (const u of unmatched.slice(0, 12)) console.log(`    ${u}`);
    if (unmatched.length > 12) console.log(`    …and ${unmatched.length - 12} more`);
  }
  if (conflicts.length) {
    console.log(`\n  ${conflicts.length} CONFLICT(S) — left alone, not overwritten:`);
    for (const c of conflicts) console.log(`    ${c}`);
  }

  if (dryRun) {
    console.log('\n--dry-run: nothing written.\n');
    return;
  }
  if (toWrite.length === 0) {
    console.log('\nNothing to write.\n');
    return;
  }

  const sourceUrl = `${DASHBOARD_BASE}/2026/${EEID_2026}LiteMapsNational.js`;
  await withTransaction(async (client) => {
    for (const w of toWrite) {
      await client.query(
        `UPDATE council_seats
            SET total_seats = $2, pr_seats = $3,
                source = 'IEC_RESULTS_DASHBOARD', source_url = $4,
                confirmed_on = current_date,
                notes = $5, updated_at = now()
          WHERE demarcation_code = $1`,
        [w.code, w.total, w.pr, sourceUrl,
         `AvailableSeats from the IEC 2026 results dashboard, read `
         + `${national.ReportDate}. Council size is structural and does not `
         + `change as the count completes.`]);
    }
  });

  console.log(`\nWrote ${toWrite.length} council size(s).`);
  const after = await pool.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM council_seats WHERE total_seats IS NULL');
  console.log(`${after.rows[0]!.n} council(s) still without a total.`);
  console.log('The seat engine can now project the rest: npm run verify, then');
  console.log('the Seat projection screen.\n');
};

main()
  .catch((error) => { console.error(error.message ?? error); process.exitCode = 1; })
  .finally(() => pool.end());
