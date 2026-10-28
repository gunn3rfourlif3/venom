import { readFileSync } from 'node:fs';
import { pool } from '../db.js';
import { recorded } from '../sources/promote.js';

/* Loads a certified candidate list from CSV.
 *
 *   npm run import:candidates -- gt_candidates_2026.csv --certified 2026-09-16
 *
 * The CSV comes from `revisions/parse_candidates.py`, which reads the IEC's
 * published PDF and drops the identity numbers before writing. This importer
 * refuses any row carrying one anyway: the parser and the schema should not
 * be the only two things standing between a date of birth and the database.
 *
 * Expected columns:
 *   demarcation_code, municipality, party, ward_id, list_order, candidate_name
 *
 * Re-running is safe. The unique constraint makes every row an upsert, so a
 * corrected list can be loaded over a previous one without duplicating.
 */

const file = process.argv[2];
if (!file) {
  console.error('usage: import:candidates <csv> [--certified YYYY-MM-DD] [--url <url>]');
  await pool.end();
  process.exit(1);
}

const opt = (name: string): string | null => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1] ?? null;
};
const certifiedOn = opt('certified');
const sourceUrl = opt('url');

/* A minimal CSV reader. The IEC data carries commas inside party names
   ("VRYHEIDSFRONT PLUS | FREEDOM FRONT PLUS" is fine, but others are not),
   so quoted fields have to be handled rather than split on every comma. */
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; }
      } else { cell += ch; }
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { row.push(cell); cell = ''; continue; }
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    if (ch !== '\r') cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }

  const header = rows.shift();
  if (!header) throw new Error('empty csv');
  return rows
    .filter((r) => r.some((c) => c.trim() !== ''))
    .map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

const rows = parseCsv(readFileSync(file, 'utf8'));
console.log(`${rows.length.toLocaleString('en-ZA')} rows in ${file}`);

/* Checked here as well as in the schema. Three independent refusals is not
   excessive for the one field that must never land. */
const ID_SHAPE = /\d{6}\*{4}|\d{13}|\d{6}\s*\*{2,}/;
const tainted = rows.filter((r) => ID_SHAPE.test(Object.values(r).join(' ')));
if (tainted.length) {
  console.error(`refusing the file: ${tainted.length} row(s) carry an identity number`);
  console.error(`  first: ${JSON.stringify(tainted[0])}`);
  await pool.end();
  process.exit(1);
}

const { run } = await recorded('iec_candidates', async (c) => {
  let kept = 0;
  for (const r of rows) {
    const wardId = r.ward_id || null;
    const listOrder = r.list_order ? Number(r.list_order) : null;
    if ((wardId === null) === (listOrder === null)) continue;  // schema would reject

    const res = await c.query(
      `INSERT INTO candidate
         (demarcation_code, municipality, party, ward_id, list_order,
          candidate_name, certified_on, source_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (demarcation_code, party, ward_id, list_order, candidate_name)
         DO NOTHING`,
      [r.demarcation_code, r.municipality, r.party, wardId, listOrder,
       r.candidate_name, certifiedOn, sourceUrl]);
    kept += res.rowCount ?? 0;
  }
  return { result: { kept }, seen: rows.length, kept };
});

console.log(run.ok
  ? `ok — ${run.itemsSeen?.toLocaleString('en-ZA')} seen, ${run.itemsKept?.toLocaleString('en-ZA')} written`
  : `failed — ${run.error}`);

await pool.end();
process.exit(run.ok ? 0 : 1);
