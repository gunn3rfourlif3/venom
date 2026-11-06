/* Load the IEC's published 2026 results.
 *
 *   npm run import:iec -- --dry-run
 *   npm run import:iec                 # council level, all 213
 *   npm run import:iec -- --vds        # also voting-district detail (slow)
 *
 * Reads the results dashboard's own JSON files. No credentials: the ones
 * this project waited for never arrived, and it turns out the numbers that
 * mattered never needed them.
 *
 * THESE ARE NOT OUR NUMBERS. They go into iec_municipality_result, which
 * nothing sums with result_vote. See migration 057 for why that separation
 * is load-bearing rather than tidiness: if IEC figures could reach
 * result_vote, a tally commitment would end up sealing numbers copied from
 * the IEC as though this campaign had captured them.
 */

import { pool, withTransaction } from '../db.js';
import {
  fetchNational, fetchMunicipality, municipalitiesOf, availableSeats,
  EEID_2026, DASHBOARD_BASE, type MunicipalityResult,
} from '../iec/dashboard.js';

const dryRun = process.argv.includes('--dry-run');
const withVds = process.argv.includes('--vds');

/* Polite serial-ish fetching. The dashboard is serving a live election and
   this is a third party's infrastructure on its busiest night of the decade:
   a few at a time, not 213 at once. */
const CONCURRENCY = 4;

async function mapLimit<T, R>(
  items: T[], limit: number, fn: (t: T, i: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  }));
  return out;
}

const main = async () => {
  process.stdout.write('Fetching the national results file… ');
  const national = await fetchNational();
  const all = municipalitiesOf(national);
  console.log(`${all.length} councils, as at ${national.ReportDate}`);
  console.log(`  ${national.VDsComplete.toLocaleString('en-ZA')} of `
    + `${national.VDExpected.toLocaleString('en-ZA')} voting districts counted `
    + `(${national.Perc_VDsComplete}%)`);
  if (national.Perc_VDsComplete < 100) {
    console.log('  COUNT IS STILL RUNNING — every row loaded now is a snapshot,');
    console.log('  and is stored with its own completeness so it cannot later be');
    console.log('  mistaken for a final result.\n');
  }

  const known = new Set((await pool.query<{ c: string }>(
    'SELECT demarcation_code AS c FROM municipality')).rows.map((r) => r.c));

  const wanted = all.filter((m) => known.has(m.code));
  const skipped = all.filter((m) => !known.has(m.code));
  if (skipped.length) {
    console.log(`  ${skipped.length} council(s) not in our register, skipped: `
      + skipped.map((s) => s.code).join(', '));
  }

  console.log(`\nFetching ${wanted.length} council files…`);
  let done = 0;
  const detailed = await mapLimit(wanted, CONCURRENCY, async (m) => {
    try {
      const full = await fetchMunicipality(m.MunicipalityID);
      done += 1;
      if (done % 40 === 0) process.stdout.write(`  ${done}/${wanted.length}\n`);
      return { code: m.code, full, error: null as string | null };
    } catch (error) {
      done += 1;
      return { code: m.code, full: null, error: (error as Error).message };
    }
  });

  const failed = detailed.filter((d) => d.error);
  const ok = detailed.filter((d): d is { code: string; full: MunicipalityResult; error: null } =>
    d.full !== null);
  console.log(`  fetched ${ok.length}, failed ${failed.length}`);
  for (const f of failed.slice(0, 8)) console.log(`    ${f.code}: ${f.error}`);

  type Row = {
    code: string; party: string; wardVotes: number; prVotes: number; valid: number;
    wardSeats: number; prSeats: number; totalSeats: number; avail: number;
    reg: number | null; cast: number | null; spoilt: number | null;
    countedVds: number | null; expectedVds: number | null; complete: boolean;
    reportDate: string;
  };
  const rows: Row[] = [];
  const oddities: string[] = [];
  let pending = 0;

  for (const { code, full } of ok) {
    let avail: number | null;
    try { avail = availableSeats(full); } catch (e) { oddities.push(`${code}: ${(e as Error).message}`); continue; }
    if (!avail) { oddities.push(`${code}: no council size`); continue; }

    const vdsExpected = (full as unknown as { VDExpected?: number }).VDExpected ?? null;
    const vdsDone = (full as unknown as { VDsComplete?: number }).VDsComplete ?? null;
    const complete = vdsExpected !== null && vdsDone !== null && vdsDone >= vdsExpected;

    for (const p of full.PartyBallotResults ?? []) {
      /* The dashboard carries an aggregate "OTHER" bucket in some views.
         Loading it beside real parties would make any later sum wrong in a
         way that is hard to spot, so it is excluded and counted. */
      if (!p.Name || p.Name.toUpperCase() === 'OTHER') continue;
      const ward = p.WardSeatsWon ?? 0;
      const pr = p.PRSeatsWon ?? 0;
      const total = p.TotalSeatsWon ?? (ward + pr);
      /* Mid-count, the compensatory total entitlement legitimately runs
         ahead of the settled ward+PR allocation - see migration 058. Only a
         council the IEC reports COMPLETE has to add up, and dropping these
         rows would discard exactly the councils still worth watching. */
      if (complete && total !== ward + pr) {
        oddities.push(`${code} ${p.Name}: declared complete but total seats `
          + `${total} != ${ward}+${pr}`);
        continue;
      }
      if (!complete && total !== ward + pr) pending += 1;
      rows.push({
        code, party: p.Name,
        wardVotes: p.WardVotes ?? 0, prVotes: p.PRVotes ?? 0,
        valid: p.TotalValidVotes ?? 0,
        wardSeats: ward, prSeats: pr, totalSeats: total, avail,
        reg: p.RegisteredVoters ?? null, cast: p.TotalVotesCast ?? null,
        spoilt: p.SpoiltVotes ?? null,
        countedVds: vdsDone, expectedVds: vdsExpected, complete,
        reportDate: full.ReportDate ?? national.ReportDate,
      });
    }
  }

  const completeCouncils = new Set(rows.filter((r) => r.complete).map((r) => r.code)).size;
  console.log(`\n  ${rows.length.toLocaleString('en-ZA')} party rows across `
    + `${new Set(rows.map((r) => r.code)).size} councils `
    + `(${completeCouncils} reported complete)`);
  if (pending > 0) {
    console.log(`  ${pending} row(s) mid-count: total entitlement ahead of the`);
    console.log('    settled allocation. Expected — see v_iec_pending_seats.');
  }
  if (oddities.length) {
    console.log(`  ${oddities.length} row(s) skipped as inconsistent:`);
    for (const o of oddities.slice(0, 8)) console.log(`    ${o}`);
  }

  if (dryRun) { console.log('\n--dry-run: nothing written.\n'); return; }

  const sourceUrl = `${DASHBOARD_BASE}/2026/${EEID_2026}Munic<id>.js`;
  await withTransaction(async (client) => {
    for (const r of rows) {
      await client.query(
        `INSERT INTO iec_municipality_result
           (demarcation_code, electoral_event, party, ward_votes, pr_votes,
            total_valid_votes, ward_seats_won, pr_seats_won, total_seats_won,
            available_seats, registered_voters, total_votes_cast, spoilt_votes,
            counted_vds, expected_vds, is_complete, report_date, source_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         ON CONFLICT (demarcation_code, electoral_event, party) DO UPDATE SET
           ward_votes = EXCLUDED.ward_votes, pr_votes = EXCLUDED.pr_votes,
           total_valid_votes = EXCLUDED.total_valid_votes,
           ward_seats_won = EXCLUDED.ward_seats_won,
           pr_seats_won = EXCLUDED.pr_seats_won,
           total_seats_won = EXCLUDED.total_seats_won,
           available_seats = EXCLUDED.available_seats,
           registered_voters = EXCLUDED.registered_voters,
           total_votes_cast = EXCLUDED.total_votes_cast,
           spoilt_votes = EXCLUDED.spoilt_votes,
           counted_vds = EXCLUDED.counted_vds,
           expected_vds = EXCLUDED.expected_vds,
           is_complete = EXCLUDED.is_complete,
           report_date = EXCLUDED.report_date,
           fetched_at = now()`,
        [r.code, EEID_2026, r.party, r.wardVotes, r.prVotes, r.valid,
         r.wardSeats, r.prSeats, r.totalSeats, r.avail, r.reg, r.cast, r.spoilt,
         r.countedVds, r.expectedVds, r.complete, r.reportDate, sourceUrl]);
    }
  });
  console.log(`\nWrote ${rows.length.toLocaleString('en-ZA')} council-level rows.`);

  if (withVds) {
    let vdRows = 0;
    await withTransaction(async (client) => {
      for (const { code, full } of ok) {
        for (const w of full.WardResults ?? []) {
          for (const vd of w.VotingDistrictResults ?? []) {
            const vdNo = String(vd.VDNumber ?? vd.VotingDistrictID ?? '').trim();
            if (!vdNo) continue;
            for (const p of vd.PartyBallotResults ?? []) {
              if (!p.Name || p.Name.toUpperCase() === 'OTHER') continue;
              await client.query(
                `INSERT INTO iec_vd_result
                   (vd_number, electoral_event, demarcation_code, ward_code,
                    ballot, party, votes, report_date)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                 ON CONFLICT (vd_number, electoral_event, ballot, party)
                 DO UPDATE SET votes = EXCLUDED.votes, fetched_at = now()`,
                [vdNo, EEID_2026, code, String(w.WardID ?? ''), 'ALL',
                 p.Name, p.TotalValidVotes ?? 0, full.ReportDate]);
              vdRows += 1;
            }
          }
        }
      }
    });
    console.log(`Wrote ${vdRows.toLocaleString('en-ZA')} voting-district rows.`);
  }

  console.log('\nNext: npm run seats:verify-2026 — the engine against all of it.\n');
};

main()
  .catch((error) => { console.error(error.message ?? error); process.exitCode = 1; })
  .finally(() => pool.end());
