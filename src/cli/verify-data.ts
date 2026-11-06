/* Checks that the data is producing correct outputs.
 *
 *   npm run verify
 *
 * Exits non-zero if any check fails. Every check states what it expects and
 * why, so a failure tells you what is wrong rather than that something is.
 *
 * THIS EXISTS BECAUSE THE FAILURES ON THIS PROJECT HAVE ALL BEEN QUIET ONES.
 * A view that reported SUPPLY_OK for stations nobody had dispatched to. A
 * NULL expected_people that read as STAFFED. is_contestable's ELSE false
 * turning "never measured" into "not winnable". A unique constraint over
 * nullable columns that could not fire, so a re-import silently doubled the
 * candidate table. None of those raised an error. Each one produced a
 * confident, plausible, wrong number, and each was found by someone looking
 * at a figure and thinking it seemed off.
 *
 * Checks are grouped: INTEGRITY (the data contradicts itself), CORRECTNESS
 * (the data disagrees with the outside world), and PROVENANCE (the data
 * cannot say where it came from). A WARN is a thing to know; a FAIL is a
 * thing that makes an output wrong.
 */

import { pool } from '../db.js';
import { allocate } from '../seats/allocate.js';
import { FIXTURES } from '../seats/fixtures.js';
import { verifyChain } from '../tally/commit.js';

/* UNTESTED is a third outcome, not a shade of WARN.
 *
 * A check whose subject does not exist yet has not passed. Counting it as a
 * pass is how this harness previously reported success for weeks while
 * querying a table that was not there: the number went up, nothing was
 * examined. Several checks here cannot run until results are captured on the
 * night, and they must say so rather than inflate the pass count - the first
 * thing anyone does with a verification run is read the total.
 */
type Level = 'FAIL' | 'WARN' | 'UNTESTED';
const results: Array<{ level: Level; group: string; name: string; detail: string }> = [];
let passed = 0;

function check(group: string, name: string, ok: boolean, detail: string,
               level: Level = 'FAIL'): void {
  if (ok) { passed += 1; return; }
  results.push({ level, group, name, detail });
}

/** The subject of this check does not exist yet, so nothing was verified. */
function untested(group: string, name: string, detail: string): void {
  results.push({ level: 'UNTESTED', group, name, detail });
}

const one = async <T>(sql: string, params: unknown[] = []): Promise<T> =>
  (await pool.query(sql, params)).rows[0] as T;

// ---------------------------------------------------------------- INTEGRITY

const dupes = await one<{ n: string }>(
  `SELECT count(*)::text AS n FROM (
     SELECT demarcation_code, party, candidate_name, ward_id, list_order
       FROM candidate
      GROUP BY 1,2,3,4,5 HAVING count(*) > 1) t`);
check('INTEGRITY', 'no duplicate candidates', Number(dupes.n) === 0,
  `${dupes.n} candidate slots appear more than once. A re-import duplicated `
  + 'the list; see migration 050.');

const ids = await one<{ n: string }>(
  `SELECT count(*)::text AS n FROM candidate
    WHERE candidate_name ~ '\\d{6}' OR candidate_name ~ '\\d{13}'`);
check('INTEGRITY', 'no identity numbers in candidate names', Number(ids.n) === 0,
  `${ids.n} candidate names contain an identity-number shape. These must `
  + 'never be stored, masked or whole.');

const wardXor = await one<{ n: string }>(
  `SELECT count(*)::text AS n FROM candidate
    WHERE (ward_id IS NULL) = (list_order IS NULL)`);
check('INTEGRITY', 'every candidate is ward XOR list', Number(wardXor.n) === 0,
  `${wardXor.n} candidates are both or neither. A ward candidate contests a `
  + 'seat; a list candidate does not. Conflating them makes "wards without a '
  + 'candidate" unanswerable.');

const provinceNames = await one<{ n: string }>(
  `SELECT count(*)::text AS n FROM (
     SELECT province_code FROM municipality WHERE province_code IS NOT NULL
      GROUP BY province_code HAVING count(DISTINCT province_name) > 1) t`);
check('INTEGRITY', 'one name per province code', Number(provinceNames.n) === 0,
  `${provinceNames.n} province codes map to more than one spelling. A `
  + 'province spelled two ways is two provinces to every GROUP BY.');

const orphanSignal = await one<{ n: string }>(
  `SELECT count(*)::text AS n FROM issue_signal s
    WHERE s.geo_level = 'WARD'
      AND NOT EXISTS (SELECT 1 FROM ward w WHERE w.ward_id = s.ward_id)`);
check('INTEGRITY', 'no signal on wards that do not exist', Number(orphanSignal.n) === 0,
  `${orphanSignal.n} signal rows point at missing wards.`);

// -------------------------------------------------------------- CORRECTNESS

for (const f of FIXTURES) {
  const got = allocate(f.input);
  const bad: string[] = [];
  if (f.expectedQuota !== undefined && got.quota !== f.expectedQuota) {
    bad.push(`quota ${got.quota} vs ${f.expectedQuota}`);
  }
  for (const p of got.parties) {
    if (f.expectedTotalSeats[p.party] !== undefined
        && p.totalSeats !== f.expectedTotalSeats[p.party]) {
      bad.push(`${p.party} total ${p.totalSeats} vs ${f.expectedTotalSeats[p.party]}`);
    }
    if (f.expectedPrSeats[p.party] !== undefined
        && p.prSeats !== f.expectedPrSeats[p.party]) {
      bad.push(`${p.party} PR ${p.prSeats} vs ${f.expectedPrSeats[p.party]}`);
    }
  }
  check('CORRECTNESS', `seat engine reproduces ${f.name}`, bad.length === 0,
    bad.join('; ') + '. The engine must reproduce an election that already '
    + 'happened before anything it projects is worth showing.');
}

/* South Africa has 257 municipalities: 8 metropolitan, 205 local and 44
   district. This is a fixed, externally verifiable fact and the single
   cheapest check that the register is neither short nor padded with
   disestablished councils. */
const munis = await one<{ a: string; b: string; c: string }>(
  `SELECT count(*) FILTER (WHERE category = 'A' AND is_active)::text AS a,
          count(*) FILTER (WHERE category = 'B' AND is_active)::text AS b,
          count(*) FILTER (WHERE category = 'C' AND is_active)::text AS c
     FROM municipality`);
check('CORRECTNESS', 'municipality counts match the country',
  munis.a === '8' && munis.b === '205' && munis.c === '44',
  `metros ${munis.a} (expect 8), locals ${munis.b} (expect 205), `
  + `districts ${munis.c} (expect 44).`);

const provinces = await one<{ n: string }>(
  `SELECT count(DISTINCT province_name)::text AS n FROM municipality`);
check('CORRECTNESS', 'nine provinces', provinces.n === '9',
  `${provinces.n} distinct province names.`);

const wardless = await one<{ n: string }>(
  `SELECT count(*)::text AS n FROM municipality m
    WHERE m.is_active AND m.category IN ('A','B')
      AND NOT EXISTS (SELECT 1 FROM ward w WHERE w.demarcation_code = m.demarcation_code)`);
check('CORRECTNESS', 'every active council has wards', Number(wardless.n) === 0,
  `${wardless.n} active metro/local councils hold no wards. A warded council `
  + 'with no wards is either a register gap or a council that no longer exists.');

const noGeo = await one<{ n: string }>(
  `SELECT count(*)::text AS n FROM station
    WHERE latitude IS NULL OR longitude IS NULL`);
check('CORRECTNESS', 'every station has coordinates', Number(noGeo.n) === 0,
  `${noGeo.n} stations have no position. The maps place a station at its `
  + 'own coordinates; one without is simply absent from them.', 'WARN');

/* The heat views must never report a measured-looking number for a place
   nothing was collected about. This is the ELSE-branch fault, checked. */
const falseCalm = await one<{ n: string }>(
  `SELECT count(*)::text AS n FROM v_issue_heat_ward
    WHERE NOT has_signal AND net_sentiment IS NOT NULL`);
check('CORRECTNESS', 'unmeasured places carry no sentiment', Number(falseCalm.n) === 0,
  `${falseCalm.n} wards report a sentiment score with no signal behind it. `
  + 'On a heatmap, a number is a colour and a colour is a claim.');

const basisGap = await one<{ n: string }>(
  `SELECT count(*)::text AS n FROM v_issue_heat_ward
    WHERE has_signal AND signal_basis = 'none'`);
check('CORRECTNESS', 'every measured place states its basis', Number(basisGap.n) === 0,
  `${basisGap.n} wards have signal but report basis 'none'.`);

// --------------------------------------------------------------- PROVENANCE

const unscored = await one<{ n: string }>(
  `SELECT count(*)::text AS n FROM issue_signal WHERE scorer IS NULL`);
check('PROVENANCE', 'every signal names its scorer', Number(unscored.n) === 0,
  `${unscored.n} signals do not record what scored them. A sentiment value `
  + 'without its scorer cannot be compared to one from a different lexicon.');

const synth = await one<{ rows: string; wards: string }>(
  `SELECT count(*)::text AS rows, count(DISTINCT ward_id)::text AS wards
     FROM issue_signal WHERE source = 'SYNTHETIC'`);
check('PROVENANCE', 'no synthetic signal present', Number(synth.rows) === 0,
  `${synth.rows} synthetic signal rows across ${synth.wards} wards. This is `
  + 'expected while demonstrating the system - they are marked, ringed on the '
  + 'map and removable with clean:synthetic. It is listed so nobody is '
  + 'surprised by it in front of an audience.', 'WARN');

const seatTotals = await one<{ pending: string; total: string }>(
  `SELECT count(*) FILTER (WHERE total_seats IS NULL)::text AS pending,
          count(*)::text AS total FROM council_seats`);
check('PROVENANCE', 'council seat totals confirmed',
  Number(seatTotals.pending) === 0,
  `${seatTotals.pending} of ${seatTotals.total} councils have no confirmed `
  + 'seat total, so the seat engine will refuse to project them. The total '
  + 'cannot be derived from the ward count.', 'WARN');

/* NO .catch() HERE, DELIBERATELY. The first version of this check queried a
   table called `fact`, which does not exist - it is `service_fact` - and
   swallowed the error with `.catch(() => ({ n: '0' }))`. The check then
   reported PASS forever while testing nothing at all. A verification harness
   that fails open is worse than no harness: it manufactures confidence. If a
   query here is wrong, the run should die and say so. */
const treasuryZero = await one<{ n: string }>(
  `SELECT count(*)::text AS n FROM municipality m
    WHERE m.is_active AND m.category IN ('A','B')
      AND NOT EXISTS (SELECT 1 FROM service_fact f
                       WHERE f.demarcation_code = m.demarcation_code)`);
check('PROVENANCE', 'audited finances present for every council',
  Number(treasuryZero.n) === 0,
  `${treasuryZero.n} councils have no Treasury facts. A municipality that has `
  + 'not published audited actuals is itself worth knowing - but it must '
  + 'never render as R0.', 'WARN');

/* ---- the tally source double-count regression (054) -------------------
   Joining result_vote to result_transcription counts every two-pass slip
   twice, and double entry means every verified slip has two passes. It
   doubled seat projections while looking like results arriving. The guard is
   a live comparison rather than a grep, because the fault can come back
   through any new query, not only through the one that was fixed. */
const dupeVotes = await one<{ naive: string; dedup: string }>(
  `SELECT
     COALESCE((SELECT SUM(rv.votes) FROM result_vote rv
                 JOIN result_transcription rt USING (transcription_id)
                 JOIN result_slip rs ON rs.slip_id = rt.slip_id
                WHERE rs.rejected IS NULL AND rs.superseded IS NOT TRUE
                  AND rs.status IN ('VERIFIED','TRANSCRIBED')), 0)::text AS naive,
     COALESCE((SELECT SUM(votes) FROM v_tally_vote), 0)::text            AS dedup`);
if (Number(dupeVotes.dedup) === 0) {
  untested('CORRECTNESS', 'vote totals are not double-counted',
    'No results are captured, so there is nothing to double-count and this '
    + 'check examined nothing. It becomes live as slips arrive. The '
    + 'deduplication itself is proved by migration 054, which fails if the '
    + 'naive join stops doubling a known fixture.');
} else {
  check('CORRECTNESS', 'vote totals are not double-counted',
    Number(dupeVotes.naive) >= Number(dupeVotes.dedup),
    `v_tally_vote totals ${Number(dupeVotes.dedup).toLocaleString('en-ZA')} but `
    + `the naive join totals ${Number(dupeVotes.naive).toLocaleString('en-ZA')} - `
    + 'less than the deduplicated figure, which should be impossible and '
    + 'means v_tally_vote is counting something twice itself.');
}

/* ---- the commitment chain (053, 055) ---------------------------------- */
const chain = await pool.query<{
  seq: number; scope: string; scope_key: string; taken_at: Date;
  slips_captured: number; slips_expected: number;
  prev_digest: string; digest: string; nonce: string;
  counts: Array<{ party: string; votes: number }>; revealed_at: Date | null;
}>(`SELECT seq, scope, scope_key, taken_at, slips_captured, slips_expected,
           prev_digest, digest, nonce, counts, revealed_at
      FROM tally_commitment ORDER BY seq`);

if (chain.rows.length === 0) {
  untested('PROVENANCE', 'tally commitment chain verifies',
    'The chain is empty - nothing has been sealed, so nothing was checked. '
    + 'Seal a snapshot with `npm run tally:commit -- --scope NATIONAL`.');
} else {
  const problems = verifyChain(chain.rows.map((r) => ({
    ...r,
    // Sealed links keep their counts in the table; verifyChain recomputes
    // only what has been revealed, so sealed ones are passed as unrevealed.
    nonce: r.revealed_at ? r.nonce : null,
    counts: r.revealed_at ? r.counts : null,
  })));
  const revealed = chain.rows.filter((r) => r.revealed_at).length;
  check('PROVENANCE', 'tally commitment chain verifies',
    problems.length === 0,
    `${problems.length} problem(s) in the chain: ${problems[0]?.detail ?? ''} `
    + '— run `npm run tally:verify` for all of them.');
  if (problems.length === 0 && revealed === 0) {
    untested('PROVENANCE', 'commitment digests reproduce from their counts',
      `${chain.rows.length} link(s) join up, but every one is still sealed so `
      + 'no digest was recomputed. Linkage is not the same as a digest '
      + 'matching its own contents.');
  }
}

// ------------------------------------------------------------------- report

const fails = results.filter((r) => r.level === 'FAIL');
const warns = results.filter((r) => r.level === 'WARN');
const untestedItems = results.filter((r) => r.level === 'UNTESTED');

console.log(`${passed} checks passed, ${fails.length} failed, `
  + `${warns.length} warnings, ${untestedItems.length} untested\n`);

for (const group of ['INTEGRITY', 'CORRECTNESS', 'PROVENANCE']) {
  const inGroup = results.filter((r) => r.group === group);
  if (!inGroup.length) continue;
  console.log(group);
  for (const r of inGroup) {
    console.log(`  ${r.level}  ${r.name}`);
    console.log(`        ${r.detail}`);
  }
  console.log('');
}

if (fails.length === 0) {
  /* Deliberately says "everything checked" and names what was not. The
     distinction is the whole point of the UNTESTED level: a run that reports
     success while several checks had no subject is how false confidence gets
     manufactured. */
  const lines: string[] = [];
  lines.push(warns.length === 0
    ? 'Everything checked is correct.'
    : 'Nothing is wrong. The warnings above are inputs that have not arrived.');
  if (untestedItems.length > 0) {
    lines.push(`${untestedItems.length} check(s) examined nothing, because what `
      + 'they test does not exist yet. They are not passes:');
    for (const u of untestedItems) lines.push(`  - ${u.name}`);
  }
  console.log(lines.join('\n'));
}

await pool.end();
process.exit(fails.length === 0 ? 0 : 1);
