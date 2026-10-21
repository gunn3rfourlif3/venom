import { pool } from '../db.js';

/* What the register actually holds.
 *
 *   npm run coverage
 *
 * Exists because checking this is a recurring need - before and after a
 * register load, before cleaning synthetic geography, and on the morning of
 * the 4th - and because the obvious way to check it was a psql one-liner,
 * which is not on PATH on Windows. That is GOTCHAS.md G13, and the answer
 * there was the same as here: if a routine check depends on a tool being
 * installed, ship the check instead.
 */

const NATIONAL = { wards: 4488, stations: 23699 };

const [byProvince, municipalities, totals] = await Promise.all([
  pool.query('SELECT * FROM v_register_coverage'),
  pool.query(
    `SELECT province_code, count(*)::int AS municipalities,
            count(*) FILTER (WHERE category = 'C')::int AS districts
       FROM municipality GROUP BY 1 ORDER BY 1`),
  pool.query(
    `SELECT count(*)::int                                        AS ward_rows,
            count(*) FILTER (WHERE delimitation = '2026')::int   AS real_2026,
            count(*) FILTER (WHERE delimitation IS NULL)::int    AS unconfirmed,
            count(*) FILTER (WHERE roll_source = 'SYNTHETIC')::int AS synthetic_roll,
            (SELECT count(*)::int FROM station)                  AS stations
       FROM ward`),
]);

console.log('\nMunicipalities loaded, by province');
console.table(municipalities.rows);

console.log('\nRegister coverage');
console.table(byProvince.rows);

const t = totals.rows[0]!;
console.log('\nTotals');
console.table([t]);

const missingWards = NATIONAL.wards - Number(t.real_2026);
const missingStations = NATIONAL.stations - Number(t.stations);

console.log(`\nNationally there are ${NATIONAL.wards} wards and `
  + `${NATIONAL.stations} voting stations for 4 November.`);

if (missingWards > 50 || missingStations > 200) {
  console.log(`\nSHORT BY ${missingWards} wards and ${missingStations} stations.`);
  const provinces = new Set(byProvince.rows.map((r) => String(r.province)));
  const expected = ['Eastern Cape', 'Free State', 'Gauteng', 'KwaZulu-Natal',
    'Limpopo', 'Mpumalanga', 'North West', 'Northern Cape', 'Western Cape'];
  const absent = expected.filter((p) => !provinces.has(p));
  if (absent.length > 0) {
    console.log(`Missing entirely: ${absent.join(', ')}`);
    console.log('Run:  npm run build && npm run sources:register');
  } else {
    console.log('All provinces present, so this is wards without their voting');
    console.log('districts yet. Re-run `npm run sources:register` - it resumes.');
  }
} else {
  console.log('\nRegister looks complete.');
}

if (Number(t.unconfirmed) > 0) {
  console.log(`\n${t.unconfirmed} ward rows have no confirmed delimitation.`);
  console.log('Once the register is complete, `npm run clean:synthetic` lists them.');
}

await pool.end();
process.exit(0);
