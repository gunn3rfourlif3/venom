/**
 * Import municipality-level facts from a CSV you downloaded.
 *
 *   npm run import:facts -- --file ghs2024.csv --source datafirst \
 *     --publisher "DataFirst (UCT), General Household Survey 2024" \
 *     --url https://www.datafirst.uct.ac.za/dataportal/... --year 2024
 *   npm run import:facts -- ... --commit
 *
 * WHY A FILE AND NOT A FETCHER.
 *
 * DataFirst's robots.txt disallows automated access to the catalogue, and
 * every dataset carries a licence agreement a person has to accept. There is
 * no version of "connect DataFirst" that is a scheduled job: the lawful
 * shape is a human registering, accepting the terms, downloading the file,
 * and loading it deliberately. This is that last step.
 *
 * The same importer serves Stats SA tables, a municipal IDP extract, or
 * anything else that is one number per municipality per year. One loader,
 * many publishers, and the provenance travels with each row — source_id,
 * publisher_label and source_url are recorded so that a figure on a screen
 * can always be traced to the file and licence it came from.
 *
 * WHAT IT WILL NOT DO. Guess. A row whose municipality cannot be matched is
 * refused and listed, never dropped quietly and never attached to a
 * best-guess code. A survey that is representative at province level does
 * not become ward-level data by being loaded into a table that has a
 * municipality column.
 *
 * CSV columns (header row required, order free):
 *   municipality   name or demarcation code  (required)
 *   metric         e.g. unemployment_rate    (required)
 *   value          numeric                   (required)
 *   unit           e.g. percent              (optional)
 *   year           overrides --year          (optional)
 */

import { readFile } from 'node:fs/promises';
import { pool } from '../db.js';

const text = (name: string): string | null => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : (process.argv[i + 1] ?? null);
};

const file = text('file');
const sourceId = text('source');
const publisher = text('publisher');
const url = text('url');
const defaultYear = Number(text('year'));
const commit = process.argv.includes('--commit');

if (!file || !sourceId || !publisher) {
  console.error('usage: import:facts -- --file <csv> --source <source_id> '
    + '--publisher "<label>" [--url <u>] [--year <y>] [--commit]');
  process.exit(1);
}

/* Minimal CSV reader: handles quoted fields containing commas, which is the
   only complication these files reliably have. Not a general parser, and it
   says so rather than pretending to be one. */
function parseCsv(raw: string): Array<Record<string, string>> {
  const lines = raw.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) return [];
  const split = (line: string): string[] => {
    const out: string[] = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '"') {
        if (quoted && line[i + 1] === '"') { cur += '"'; i += 1; } else quoted = !quoted;
      } else if (ch === ',' && !quoted) { out.push(cur); cur = ''; } else cur += ch;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  };
  const header = split(lines[0]!).map((h) => h.toLowerCase().replace(/\s+/g, '_'));
  return lines.slice(1).map((l) => {
    const cells = split(l);
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? '']));
  });
}

const rows = parseCsv(await readFile(file, 'utf8'));
if (rows.length === 0) {
  console.error('No data rows in that file.');
  await pool.end();
  process.exit(1);
}

const required = ['municipality', 'metric', 'value'];
const missing = required.filter((c) => !(c in rows[0]!));
if (missing.length > 0) {
  console.error(`Missing column(s): ${missing.join(', ')}`);
  console.error(`Found: ${Object.keys(rows[0]!).join(', ')}`);
  await pool.end();
  process.exit(1);
}

/* Name matching uses the same squash as the Municipal Money loader, because
   'KwaZulu-Natal' and 'Kwazulu-Natal' cost this project a full rebuild once
   already. */
const squash = (s: string) => s.toLowerCase().replace(/[\s\-'.]+/g, '');
const { rows: munis } = await pool.query<{ demarcation_code: string; name: string }>(
  'SELECT demarcation_code, name FROM municipality');
const byName = new Map(munis.map((m) => [squash(m.name), m.demarcation_code]));
const byCode = new Map(munis.map((m) => [m.demarcation_code.toUpperCase(), m.demarcation_code]));

interface Fact { code: string; year: number; metric: string; value: number; unit: string | null; }
const ready: Fact[] = [];
const refused: Array<{ line: number; why: string; row: string }> = [];

rows.forEach((r, i) => {
  const line = i + 2;
  const raw = (r.municipality ?? '').trim();
  const code = byCode.get(raw.toUpperCase()) ?? byName.get(squash(raw)) ?? null;
  if (!code) { refused.push({ line, why: `no municipality matching "${raw}"`, row: raw }); return; }

  const value = Number((r.value ?? '').replace(/[\s,%]/g, ''));
  if (!Number.isFinite(value)) { refused.push({ line, why: `"${r.value}" is not a number`, row: raw }); return; }

  const year = Number(r.year) || defaultYear;
  if (!Number.isInteger(year)) { refused.push({ line, why: 'no year on the row and no --year given', row: raw }); return; }

  const metric = (r.metric ?? '').trim();
  if (metric === '') { refused.push({ line, why: 'empty metric', row: raw }); return; }

  ready.push({ code, year, metric, value, unit: (r.unit ?? '').trim() || null });
});

console.log(`${rows.length} rows read — ${ready.length} ready, ${refused.length} refused`);
if (refused.length > 0) {
  console.log('\nRefused (not loaded, not guessed):');
  for (const f of refused.slice(0, 20)) console.log(`  line ${f.line}: ${f.why}`);
  if (refused.length > 20) console.log(`  …and ${refused.length - 20} more`);
}

if (!commit) {
  console.log('\nDry run. Nothing written. Re-run with --commit to apply.');
  if (ready.length > 0) {
    console.log('Sample of what would be written:');
    for (const f of ready.slice(0, 5)) {
      console.log(`  ${f.code} ${f.year} ${f.metric} = ${f.value}${f.unit ? ' ' + f.unit : ''}`);
    }
  }
  await pool.end();
  process.exit(0);
}

const client = await pool.connect();
let written = 0;
try {
  await client.query('BEGIN');
  for (const f of ready) {
    await client.query(
      `INSERT INTO service_fact
         (source_id, demarcation_code, financial_year, metric, value, unit,
          publisher_label, source_url, retrieved_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())`,
      [sourceId, f.code, f.year, f.metric, f.value, f.unit, publisher, url]);
    written += 1;
  }
  /* The source is marked connected by the act of loading it, which is the
     only honest signal for a manual source: it is "live" when somebody last
     brought data in, not when a scheduler last ran. */
  await client.query(
    `UPDATE source
        SET enabled = true, last_attempt_at = now(), last_ok_at = now(), last_error = NULL
      WHERE source_id = $1`, [sourceId]);
  await client.query('COMMIT');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
}

console.log(`\nWrote ${written} facts for ${sourceId}.`);
await pool.end();
