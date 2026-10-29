/* Generates clearly-marked demo issue signal, for showing the system to
 * people when the real collection is thin.
 *
 *   npm run seed:demo-signal -- --province Gauteng           # dry run
 *   npm run seed:demo-signal -- --province Gauteng --commit
 *   npm run seed:demo-signal -- --all --days 45 --commit
 *
 * WHY THIS EXISTS AND WHY IT IS SHAPED LIKE THIS.
 *
 * Xnith refuses to fabricate intelligence. That refusal has been made several
 * times on this project and it stands: no invented sentiment presented as
 * collected, no "honeypot" rows mixed into real tables, no numbers that cannot
 * be traced to a source.
 *
 * Demo data is a different thing, but ONLY while three conditions hold, and
 * this file exists to hold them:
 *
 *   1. It is marked at the row. Every row written here carries
 *      source = 'SYNTHETIC' and scorer = 'demo-v1'. Nothing else writes those
 *      two together, so these rows are identifiable forever, by anyone, with
 *      one query - not just by whoever remembers seeding them.
 *
 *   2. It is visible on screen. `v_issue_heat_*` reports signal_basis as
 *      'synthetic' or 'mixed' for any place touched by these rows, and the
 *      issue-pressure map renders those dots with an orange dashed ring and
 *      states the count in a banner above the map. A viewer who was not in
 *      the room when it was seeded can still tell.
 *
 *   3. It is removable in one command. `npm run clean:synthetic -- --commit`
 *      deletes exactly these rows.
 *
 * If any of those three stops being true, this command has become a liability
 * and should be deleted rather than fixed. The danger is not the data. The
 * danger is a decision-maker reading an invented number as a measured one,
 * and a presentation is precisely where that happens.
 *
 * WHAT IT DOES NOT DO. It does not invent quotes, names, incidents or
 * events. It writes counts and a polarity against existing issue categories
 * for existing wards - the shape of data, not the substance of claims. There
 * is no sentence anywhere in the output that a person could repeat as a fact
 * about a real place.
 */

import { pool } from '../db.js';

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const opt = (name: string): string | null => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? null : argv[i + 1] ?? null;
};

const commit = flag('commit');
const province = opt('province');
const all = flag('all');
const days = Number(opt('days') ?? 30);
const perWard = Number(opt('categories') ?? 4);

if (!province && !all) {
  console.error('usage: seed:demo-signal --province <name> | --all [--days N] [--commit]');
  await pool.end();
  process.exit(1);
}
if (!Number.isInteger(days) || days < 1 || days > 180) {
  console.error('--days must be a whole number between 1 and 180');
  await pool.end();
  process.exit(1);
}

/* Read off the schema's own enums rather than typed from memory. The first
   attempt invented 'Worried' as a tone, which does not exist - the insert
   failed on the enum and rolled back, which is the schema doing its job, but
   the right move is to not guess in the first place.
     issue_category: Water, Electricity, Refuse, Roads, Housing, Sanitation,
                     Safety, Health, Transport, Billing, Other
     sentiment_tone: Resigned, Frustrated, Angry, Mobilising  */
const CATEGORIES = ['Water', 'Electricity', 'Refuse', 'Roads', 'Housing',
                    'Sanitation', 'Safety', 'Health', 'Transport', 'Billing'];

/* Deterministic from the ward id, so re-running produces the same picture
   rather than a different one each time - a demo that changes shape between
   rehearsal and presentation is its own kind of problem. */
function seeded(key: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h ^= h << 13; h ^= h >>> 17; h ^= h << 5;
    return ((h >>> 0) % 100000) / 100000;
  };
}

const wards = await pool.query<{ ward_id: string; municipality: string; province: string }>(
  `SELECT w.ward_id, m.name AS municipality, m.province_name AS province
     FROM ward w JOIN municipality m ON m.demarcation_code = w.demarcation_code
    WHERE ($1::text IS NULL OR m.province_name = $1)
    ORDER BY w.ward_id`,
  [all ? null : province]);

if (wards.rows.length === 0) {
  console.error(province
    ? `No wards found for province "${province}".`
    : 'No wards found.');
  await pool.end();
  process.exit(1);
}

const rows: Array<[string, string, string, number, number, string]> = [];
for (const w of wards.rows) {
  const rand = seeded(w.ward_id);
  // A ward gets a handful of categories, not all eight - real signal is patchy
  // and a demo where every ward reports everything looks like a demo.
  const picked = CATEGORIES.filter(() => rand() < perWard / CATEGORIES.length);
  for (const category of picked) {
    for (let d = 0; d < days; d++) {
      if (rand() < 0.55) continue;                  // most ward-days are quiet
      const mentions = 1 + Math.floor(rand() * 9);
      const net = Number((-0.75 + rand() * 0.9).toFixed(3));
      const tone = net < -0.5 ? 'Angry'
        : net < -0.25 ? 'Frustrated'
        : net < -0.05 ? 'Resigned' : 'Mobilising';
      rows.push([w.ward_id, category, tone, mentions, net, `-${d} days`]);
    }
  }
}

const scope = all ? 'all provinces' : province!;
console.log(`${wards.rows.length.toLocaleString('en-ZA')} wards in ${scope}`);
console.log(`${rows.length.toLocaleString('en-ZA')} demo signal rows over ${days} days`);

if (!commit) {
  console.log('\nDRY RUN - nothing written. Re-run with --commit.');
  console.log('Every row would carry source=SYNTHETIC and scorer=demo-v1,');
  console.log('render with an orange dashed ring on the issue-pressure map,');
  console.log('and be removable with: npm run clean:synthetic -- --commit');
  await pool.end();
  process.exit(0);
}

const client = await pool.connect();
let written = 0;
try {
  await client.query('BEGIN');
  for (const [wardId, category, tone, mentions, net, offset] of rows) {
    const res = await client.query(
      `INSERT INTO issue_signal
         (geo_level, ward_id, category, observed_on, mentions, net_sentiment,
          tone, source, source_url, confidence, scorer)
       VALUES ('WARD', $1, $2::issue_category,
               CURRENT_DATE + $3::interval, $4, $5, $6::sentiment_tone,
               'SYNTHETIC', NULL, 0.4, 'demo-v1')
       ON CONFLICT (ward_id, category, observed_on, source)
         WHERE geo_level = 'WARD' DO UPDATE SET
           mentions = EXCLUDED.mentions,
           net_sentiment = EXCLUDED.net_sentiment,
           tone = EXCLUDED.tone,
           scorer = EXCLUDED.scorer,
           ingested_at = now()`,
      [wardId, category, offset, mentions, net, tone]);
    written += res.rowCount ?? 0;
  }
  await client.query('COMMIT');
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(`failed, nothing written: ${(error as Error).message}`);
  client.release();
  await pool.end();
  process.exit(1);
}
client.release();

console.log(`\nwrote ${written.toLocaleString('en-ZA')} demo rows, all marked SYNTHETIC / demo-v1`);
console.log('The issue-pressure map will ring these places in orange and say so above the map.');
console.log('Remove with: npm run clean:synthetic -- --commit');

await pool.end();
