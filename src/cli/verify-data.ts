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

type Level = 'FAIL' | 'WARN';
const results: Array<{ level: Level; group: string; name: string; detail: string }> = [];
let passed = 0;

function check(group: string, name: string, ok: boolean, detail: string,
               level: Level = 'FAIL'): void {
  if (ok) { passed += 1; return; }
  results.push({ level, group, name, detail });
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

// ------------------------------------------------------------------- report

const fails = results.filter((r) => r.level === 'FAIL');
const warns = results.filter((r) => r.level === 'WARN');

console.log(`${passed} checks passed, ${fails.length} failed, ${warns.length} warnings\n`);

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
  console.log(warns.length === 0
    ? 'Everything checked is correct.'
    : 'Nothing is wrong. The warnings above are inputs that have not arrived.');
}

await pool.end();
process.exit(fails.length === 0 ? 0 : 1);
