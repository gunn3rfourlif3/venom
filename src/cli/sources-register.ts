import { pool } from '../db.js';
import { MunicipalMoneyClient } from '../sources/municipalMoney.js';
import { IecGisClient, IEC_GIS_URL } from '../sources/iecGis.js';

/* The national ward and voting-station register.
 *
 *   npm run sources:register                 # everything, resumable
 *   npm run sources:register -- --province GT
 *   npm run sources:register -- --wards-only
 *   npm run sources:register -- --limit 50   # a taste, for checking
 *
 * Municipality list from municipalmoney.gov.za, geography from the IEC's open
 * GIS API, which accepts the same demarcation codes.
 *
 * RESUMABLE BY DESIGN. This is ~4,750 calls against a public service and it
 * will be interrupted - a timeout, a laptop lid, a 500 from their GIS store.
 * So every write is an upsert and the ward walk skips wards that already have
 * stations. Re-running costs only the wards that did not finish, and running
 * it twice is harmless.
 *
 * WHICH IS WHY THIS DOES NOT USE recorded(). That helper wraps its body in a
 * single transaction, which is right for a sweep that takes seconds and wrong
 * for one that takes an hour: it would hold a transaction open across
 * thousands of network calls, block autovacuum on ward and station the whole
 * time, and discard every row on the first unhandled error - which is the
 * opposite of resumable. Writes here commit as they go, and the run is
 * stamped on source_run by hand.
 *
 * WHAT IT WILL NOT DO. It does not touch registered_voters on a ward that
 * already has one, and it never writes a count of its own: the GIS API serves
 * geography and has no voters' roll. A national ward therefore arrives with
 * registered_voters NULL, which is the truth. Gauteng's existing synthetic
 * figures are left exactly as they are, still stamped SYNTHETIC, so the
 * current dashboard keeps working and nothing real gets mixed into it.
 */

const PROVINCES = ['EC', 'FS', 'GT', 'KZN', 'LIM', 'MP', 'NC', 'NW', 'WC'] as const;

const flag = (name: string) => process.argv.includes(`--${name}`);
const opt = (name: string): string | null => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1] ?? null;
};
const optNum = (name: string, fallback: number) => {
  const raw = opt(name);
  // The null check is the point. Number(null) is 0, not NaN, and
  // Number.isFinite(0) is true - so the obvious one-liner silently defaulted
  // --limit to zero and the whole station walk fetched nothing while
  // reporting success. It cost a full national run to notice.
  if (raw === null || raw.trim() === '') return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
};

const only = opt('province');
const wardsOnly = flag('wards-only');
const limit = optNum('limit', Infinity);
const provinces = only ? [only.toUpperCase()] : [...PROVINCES];

const money = new MunicipalMoneyClient();
const gis = new IecGisClient();

console.log(`Register load — ${provinces.join(', ')}`);
console.log(`Municipalities from municipalmoney, geography from ${IEC_GIS_URL}\n`);

const client = pool;
const failures: string[] = [];
const defunct: string[] = [];
let municipalities = 0;
let wards = 0;
let stations = 0;
let skipped = 0;

const { rows: runRow } = await client.query<{ source_run_id: string }>(
  `INSERT INTO source_run (source_id) VALUES ('iec_gis') RETURNING source_run_id`);
const runId = runRow[0]!.source_run_id;
await client.query(`UPDATE source SET last_attempt_at = now() WHERE source_id = 'iec_gis'`);

try {
  // ---------------------------------------------------------- municipalities
  //
  // One unfiltered request for all ~292, rather than one per province. See
  // allMunicipalities() for why: the cube's province_code is not self
  // consistent and filtering by it returns defunct municipalities for
  // KwaZulu-Natal and Limpopo.
  {
    let rows: Awaited<ReturnType<typeof money.allMunicipalities>>;
    try {
      rows = await money.allMunicipalities();
    } catch (error) {
      failures.push(`municipality list — ${(error as Error).message}`);
      rows = [];
    }

    const wanted = rows.filter(
      (m) => m.province_code !== null && provinces.includes(m.province_code));
    const unmapped = rows.filter((m) => m.province_code === null);
    if (unmapped.length > 0) {
      failures.push(`${unmapped.length} municipalities had an unrecognised province name`);
    }

    for (const m of wanted) {
      try {
        await client.query(
          `INSERT INTO municipality
             (demarcation_code, name, category, province_code, province_name)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (demarcation_code) DO UPDATE
             SET name          = EXCLUDED.name,
                 category      = EXCLUDED.category,
                 province_code = EXCLUDED.province_code,
                 province_name = EXCLUDED.province_name,
                 retrieved_at  = now()`,
          [m.demarcation_code, m.name, m.category, m.province_code,
            m.province_name]);
        municipalities += 1;
      } catch (error) {
        // municipality.name carries a UNIQUE constraint, and two
        // municipalities in different provinces can share a name. The
        // conflict target above is the code, so a name collision raises
        // rather than updating. Recorded and skipped: losing one
        // municipality is better than losing the province.
        const code = (error as { code?: string }).code;
        failures.push(`${m.demarcation_code} (${m.name}): `
          + (code === '23505' ? 'name already used by another municipality'
            : (error as Error).message));
      }
    }
    const byProvince = new Map<string, number>();
    for (const m of wanted) {
      byProvince.set(m.province_code!, (byProvince.get(m.province_code!) ?? 0) + 1);
    }
    for (const p of provinces) {
      console.log(`  ${p.padEnd(4)} ${String(byProvince.get(p) ?? 0).padStart(3)} municipalities`);
    }
  }

  // ------------------------------------------------------------------ wards
  // Category C is a district municipality, which has no wards of its own -
  // its wards belong to the local municipalities inside it. Excluded here
  // rather than attempted and reported as a failure, because ~44 districts
  // nationally returning "no wards" would bury the handful of real failures
  // in noise that is entirely expected. Same reasoning as GOTCHAS.md G4.
  const { rows: munis } = await client.query<{ demarcation_code: string; name: string }>(
    `SELECT demarcation_code, name FROM municipality
      WHERE province_code = ANY($1::text[])
        AND (category IS NULL OR category <> 'C')
      ORDER BY demarcation_code`,
    [provinces]);

  console.log(`\nWalking ${munis.length} municipalities for wards`);

  for (const muni of munis) {
    let found;
    try {
      found = await gis.wards(muni.demarcation_code);
    } catch (error) {
      failures.push(`${muni.demarcation_code}: wards — ${(error as Error).message}`);
      continue;
    }
    if (found.length === 0) {
      // Expected, not broken. Municipalities that were merged away still
      // appear in municipalmoney's list - GT482 Randfontein and GT483
      // Westonaria became Rand West City in 2016 - and the IEC's current
      // register correctly has no wards for them. Noted separately from
      // failures so that a real failure stays visible.
      defunct.push(`${muni.demarcation_code} ${muni.name}`);
      continue;
    }

    for (const w of found) {
      // registered_voters and roll_source are absent from both the insert and
      // the update, and that is deliberate. This API serves no voters' roll,
      // so a new ward gets NULL and an existing ward keeps whatever count it
      // already had, still labelled with wherever that came from.
      //
      // `source` IS updated, because it now describes the geography - and the
      // geography on this row genuinely is the IEC's as of this run, even on a
      // ward that began life in the synthetic demo set. The invented voter
      // count stays labelled SYNTHETIC through roll_source.
      await client.query(
        `INSERT INTO ward (ward_id, municipality, province, demarcation_code,
                           ward_no, delimitation, source, source_fetched_at, source_url)
         VALUES ($1,$2,$3,$4,$5,'2026','IEC_GIS',now(),$6)
         ON CONFLICT (ward_id) DO UPDATE
           SET municipality      = EXCLUDED.municipality,
               province          = EXCLUDED.province,
               demarcation_code  = EXCLUDED.demarcation_code,
               ward_no           = EXCLUDED.ward_no,
               delimitation      = EXCLUDED.delimitation,
               source            = 'IEC_GIS',
               source_fetched_at = now(),
               source_url        = EXCLUDED.source_url`,
        [w.wardId, w.municipalityName, w.province, w.demarcationCode,
          w.wardNo, IEC_GIS_URL]);
      wards += 1;
    }
    console.log(`  ${muni.demarcation_code.padEnd(6)} ${String(found.length).padStart(4)} wards  ${muni.name}`);
  }

  if (wardsOnly) {
    console.log('\n--wards-only: stopping before the voting districts.');
  } else {

  // --------------------------------------------------------------- stations
  //
  // The resume list. A ward that already has stations is skipped, so an
  // interrupted run costs only what it did not finish.
  const { rows: todo } = await client.query<{ ward_id: string; municipality: string }>(
    `SELECT w.ward_id, w.municipality
       FROM ward w
       JOIN municipality m USING (demarcation_code)
      WHERE m.province_code = ANY($1::text[])
        AND NOT EXISTS (SELECT 1 FROM station s WHERE s.ward_id = w.ward_id)
      ORDER BY w.ward_id`,
    [provinces]);

  const target = Math.min(todo.length, limit);
  console.log(`\n${todo.length} wards still need voting districts`
    + `${Number.isFinite(limit) ? `; fetching ${target}` : ''}`);

  let done = 0;
  for (const ward of todo) {
    if (done >= limit) { skipped = todo.length - done; break; }
    done += 1;

    let found;
    try {
      found = await gis.stations(ward.ward_id);
    } catch (error) {
      failures.push(`ward ${ward.ward_id}: ${(error as Error).message}`);
      continue;
    }

    for (const s of found) {
      await client.query(
        `INSERT INTO station (station_id, ward_id, name, latitude, longitude,
                              street_name, suburb, town, station_type,
                              opening_time, closing_time,
                              source, source_fetched_at, source_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'IEC_GIS',now(),$12)
         ON CONFLICT (station_id) DO UPDATE
           SET ward_id      = EXCLUDED.ward_id,
               name         = EXCLUDED.name,
               latitude     = COALESCE(EXCLUDED.latitude,  station.latitude),
               longitude    = COALESCE(EXCLUDED.longitude, station.longitude),
               street_name  = EXCLUDED.street_name,
               suburb       = EXCLUDED.suburb,
               town         = EXCLUDED.town,
               station_type = EXCLUDED.station_type,
               source_fetched_at = now()`,
        [s.vdNumber, s.wardId, s.name, s.latitude, s.longitude,
          s.streetName, s.suburb, s.town, s.stationType,
          s.openTime || null, s.closeTime || null, IEC_GIS_URL]);
      stations += 1;
    }

    if (done % 100 === 0) {
      console.log(`  ${done}/${target} wards — ${stations} stations so far`);
    }
  }

  }   // end of the station walk

  console.log(`\n${municipalities} municipalities, ${wards} wards, ${stations} stations`);
  if (skipped > 0) console.log(`${skipped} wards left for the next run (--limit).`);
  if (defunct.length > 0) {
    console.log(`\n${defunct.length} municipalities have no current wards `
      + `(districts are excluded already, so these are merged-away codes):`);
    for (const d of defunct) console.log(`  ${d}`);
  }
  if (failures.length > 0) {
    console.log(`\n${failures.length} real failures — re-run to retry them:`);
    for (const f of failures.slice(0, 20)) console.log(`  ${f}`);
    if (failures.length > 20) console.log(`  …and ${failures.length - 20} more`);
  }

  // A run with failures is still a run that moved the register forward, so it
  // is recorded as ok and the failures are counted. A run that threw is not.
  await client.query(
    `UPDATE source_run
        SET finished_at = now(), ok = true, items_seen = $2, items_kept = $3,
            error = $4
      WHERE source_run_id = $1`,
    [runId, wards, stations,
      failures.length > 0 ? `${failures.length} partial failures` : null]);
  await client.query(
    `UPDATE source SET last_ok_at = now(), last_error = $1 WHERE source_id = 'iec_gis'`,
    [failures.length > 0 ? `${failures.length} partial failures` : null]);
} catch (error) {
  const message = (error as Error).message;
  await client.query(
    `UPDATE source_run SET finished_at = now(), ok = false, error = $2
      WHERE source_run_id = $1`, [runId, message]).catch(() => {});
  await client.query(
    `UPDATE source SET last_error = $1 WHERE source_id = 'iec_gis'`,
    [message]).catch(() => {});
  console.error(`\nfailed — ${message}`);
  console.error('Writes already committed are kept; re-run to continue.');
  await pool.end();
  process.exit(1);
}

const { rows } = await pool.query('SELECT * FROM v_register_coverage');
console.table(rows);

const { rows: totals } = await pool.query(
  `SELECT count(*)::int AS wards,
          count(*) FILTER (WHERE registered_voters IS NULL)::int AS without_roll,
          (SELECT count(*)::int FROM station) AS stations
     FROM ward`);
console.log(totals[0]);

await pool.end();
process.exit(0);
