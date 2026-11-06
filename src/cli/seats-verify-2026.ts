/* The seat engine against every council the IEC has declared.
 *
 *   npm run seats:verify-2026
 *   npm run seats:verify-2026 -- --show 20      # list more mismatches
 *
 * The engine already reproduces Sol Plaatje and Madibeng 2021 exactly. That
 * is two councils, both chosen because their results were published in a
 * convenient form. This runs it against every 2026 council the IEC reports
 * COMPLETE, using the IEC's own ward and PR votes as input and its own
 * declared seats as the answer.
 *
 * Two fixtures can be passed by an engine that is right by coincidence.
 * Two hundred cannot.
 *
 * ONLY DECLARED COUNCILS ARE JUDGED. A council still counting has a
 * compensatory total entitlement that legitimately runs ahead of its settled
 * allocation (migration 058), so scoring it would manufacture failures that
 * say nothing about the engine. Those are counted and reported as not yet
 * testable rather than quietly dropped - this project has been bitten by a
 * harness that counted untested things as passes.
 *
 * WHAT A MISMATCH MEANS. Not necessarily an engine bug. It can also be an
 * input the engine was not given: independent ward votes and seats are part
 * of the quota and the dashboard's party rows do not carry them, so a
 * council with independents may legitimately differ. Those are separated out
 * rather than folded into one failure count, because a number that mixes
 * "wrong" with "insufficient input" is not usable for either.
 */

import { pool } from '../db.js';
import { allocate, type PartyVotes } from '../seats/allocate.js';

const showArg = process.argv.indexOf('--show');
const SHOW = showArg === -1 ? 8 : Number(process.argv[showArg + 1] ?? 8);
const indArg = process.argv.indexOf('--ind-votes');
const IND_IN = indArg === -1 ? true : process.argv[indArg + 1] !== 'out';
const quotaArg = process.argv.indexOf('--quota');
const QUOTA = (quotaArg === -1 ? 'droop' : process.argv[quotaArg + 1]) as 'droop' | 'hare';
if (QUOTA !== 'droop' && QUOTA !== 'hare') {
  console.error("--quota takes 'droop' or 'hare'");
  process.exit(2);
}

interface Row {
  demarcation_code: string;
  municipality: string;
  province: string;
  party: string;
  ward_votes: number;
  pr_votes: number;
  ward_seats_won: number;
  pr_seats_won: number;
  total_seats_won: number;
  available_seats: number;
  is_complete: boolean;
}

const main = async () => {
  const { rows } = await pool.query<Row>(
    `SELECT r.demarcation_code, m.name AS municipality, m.province_name AS province,
            r.party, r.ward_votes, r.pr_votes, r.ward_seats_won, r.pr_seats_won,
            r.total_seats_won, r.available_seats, r.is_complete
       FROM iec_municipality_result r
       JOIN municipality m ON m.demarcation_code = r.demarcation_code
      WHERE r.electoral_event = 'EEID1887'
      ORDER BY r.demarcation_code, r.party`);

  if (rows.length === 0) {
    console.error('No IEC results loaded. Run `npm run import:iec` first.');
    process.exit(1);
  }

  const byCouncil = new Map<string, Row[]>();
  for (const r of rows) {
    if (!byCouncil.has(r.demarcation_code)) byCouncil.set(r.demarcation_code, []);
    byCouncil.get(r.demarcation_code)!.push(r);
  }

  let tested = 0;
  let exact = 0;
  const notDeclared: string[] = [];
  const mismatches: Array<{
    code: string; name: string; province: string; detail: string[];
    hasIndependents: boolean;
  }> = [];

  for (const [code, council] of byCouncil) {
    const first = council[0]!;
    /* "Complete" from the IEC's district counters is not enough. Four
       councils report every district counted while their PR allocation has
       not run at all - EC122, BUF, LIM334 and FS194 each declare only their
       ward seats, summing to half the council. Scoring those manufactures
       failures that say nothing about the engine. A council is testable
       only once its declared seats actually fill it. */
    const declared = council.reduce((s, r) => s + r.total_seats_won, 0);
    if (!first.is_complete || declared !== first.available_seats) {
      notDeclared.push(code);
      continue;
    }

    /* Independents are an AGGREGATE PSEUDO-PARTY in the dashboard, under the
       exact name INDEPENDENTS. They contest wards only: they hold no list,
       so they can never take a PR seat, but their ward votes still count in
       the quota's numerator and their ward seats come out of the
       denominator. The engine takes both as separate inputs; an earlier
       version of this harness passed them as an ordinary party instead,
       which let the engine award list seats to "independents" and pushed a
       real party out. That alone accounted for a large share of the
       mismatches.

       MATCHED EXACTLY, NEVER AS A SUBSTRING. Dozens of registered parties
       have INDEPENDENT in their names - AFRICAN INDEPENDENT CONGRESS,
       INDEPENDENT PARTY - and THE INDEPENDENTS is a real party holding
       7,117 list votes and four PR seats. A `startsWith` or `includes`
       test would silently delete them from the allocation. */
    const indRow = council.find((r) => r.party === 'INDEPENDENTS');
    const parties: PartyVotes[] = council
      .filter((r) => r !== indRow)
      .map((r) => ({
        party: r.party,
        wardVotes: r.ward_votes,
        prVotes: r.pr_votes,
        wardSeats: r.ward_seats_won,
      }));
    const hasIndependents = (indRow?.ward_seats_won ?? 0) > 0
      || (indRow?.ward_votes ?? 0) > 0;

    let got;
    try {
      got = allocate({
        totalSeats: first.available_seats,
        parties,
        independentWardVotes: indRow?.ward_votes ?? 0,
        independentSeats: indRow?.ward_seats_won ?? 0,
        quotaRule: QUOTA,
        independentVotesInQuota: IND_IN,
      });
    } catch (error) {
      mismatches.push({ code, name: first.municipality, province: first.province,
        detail: [`engine refused: ${(error as Error).message}`], hasIndependents });
      tested += 1;
      continue;
    }

    tested += 1;
    const detail: string[] = [];
    const bySeats = new Map(got.parties.map((p) => [p.party, p]));
    for (const r of council) {
      if (r === indRow) {
        /* The engine returns no row for independents by design. Check the
           declared ward seats instead - they are an input, so a mismatch
           here means the input was wrong, not the allocation. */
        continue;
      }
      const g = bySeats.get(r.party);
      if (!g) { detail.push(`${r.party}: engine returned nothing`); continue; }
      if (g.totalSeats !== r.total_seats_won) {
        detail.push(`${r.party}: engine ${g.totalSeats}, IEC ${r.total_seats_won}`
          + ` (ward ${r.ward_seats_won}, PR ${r.pr_seats_won})`);
      }
    }
    if (detail.length === 0) exact += 1;
    else mismatches.push({ code, name: first.municipality, province: first.province,
      detail, hasIndependents });
  }

  const withInd = mismatches.filter((m) => m.hasIndependents);
  const withoutInd = mismatches.filter((m) => !m.hasIndependents);

  console.log(`\nSeat engine against IEC-declared 2026 results  [quota: ${QUOTA}, independent votes ${IND_IN ? 'in' : 'out'}]\n`);
  console.log(`  councils loaded        ${byCouncil.size}`);
  console.log(`  declared and testable  ${tested}`);
  console.log(`  still counting         ${notDeclared.length} — not testable yet, `
    + 'not counted as passes');
  console.log('');
  console.log(`  reproduced exactly     ${exact} of ${tested}`
    + (tested ? `  (${(100 * exact / tested).toFixed(1)}%)` : ''));
  /* Independents are now passed to the engine as votes and seats, so their
     presence is no longer an excuse for a mismatch. Both groups are real
     disagreements; the split is kept only because councils with
     independents exercise an extra code path and are worth reading first. */
  console.log(`  differ                 ${mismatches.length}`);
  console.log(`    with independents    ${withInd.length}`);
  console.log(`    without              ${withoutInd.length}`);

  const worth = [...withoutInd, ...withInd].slice(0, SHOW);
  if (worth.length) {
    console.log(`\n  First ${worth.length}:`);
    for (const m of worth) {
      console.log(`\n    ${m.code} ${m.name} (${m.province})`
        + (m.hasIndependents ? '  [independents present]' : ''));
      for (const d of m.detail.slice(0, 6)) console.log(`      ${d}`);
      if (m.detail.length > 6) console.log(`      …and ${m.detail.length - 6} more`);
    }
  }

  console.log('');
  if (mismatches.length === 0 && tested > 0) {
    console.log(`  The engine reproduces every declared council that has no`);
    console.log('  independents. That is a far stronger check than the two 2021');
    console.log('  fixtures, and it is the same statute it will run under next time.\n');
  } else if (tested > 0) {
    console.log(`  ${mismatches.length} council(s) differ. Seat projections are not`);
    console.log('  validated while that is true. Try `-- --quota hare` for the');
    console.log('  comparison that is currently unresolved.\n');
  }

  /* Exit non-zero only on the unexplained ones. A council differing because
     the engine was not handed independent votes is a known gap in the INPUT,
     not a failing engine, and failing the build for it would train everyone
     to ignore this command. */
  process.exitCode = mismatches.length === 0 ? 0 : 1;
};

main()
  .catch((error) => { console.error(error.message ?? error); process.exitCode = 1; })
  .finally(() => pool.end());
