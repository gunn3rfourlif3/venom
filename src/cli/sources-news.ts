import { pool } from '../db.js';
import { recorded } from '../sources/promote.js';
import { NewsClient, CATEGORY_TERMS } from '../sources/news.js';
import { KeywordScorer } from '../nlp/keyword.js';
import { LocalModelScorer } from '../nlp/local.js';
import { ingest } from '../sentiment/aggregate.js';
import type { IssueCategory, Scorer } from '../nlp/types.js';

/* Pulls real news coverage into the signal table.
 *
 *   npm run sources:news
 *   npm run sources:news -- --days 30 --model
 *
 * One query per ward-holding municipality per category. Gauteng is about
 * seventy requests at a second and a half apart - roughly two minutes, the
 * polite speed for a free public feed. The whole country is 213
 * municipalities, so the same sweep is ~1,700 requests and the better part
 * of an hour; that is a decision to take deliberately rather than discover,
 * so the scope is an argument and the cost is printed before it starts.
 *
 *   npm run sources:news -- --province GT      one province
 *   npm run sources:news -- --province GT,KZN  several
 *   npm run sources:news -- --all              the whole register
 *
 * --model uses the Python scorer instead of the lexicon. Without it the
 * baseline runs, which is honest about its own confidence and needs nothing
 * installed.
 */

const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(`--${name}`);
  const v = i === -1 ? NaN : Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : fallback;
};

const days = arg('days', 56);
const useModel = process.argv.includes('--model');
const scorer: Scorer = useModel ? new LocalModelScorer() : new KeywordScorer();

/* The province filter used to be the literal string 'GT' in the query, which
   quietly kept a national register reading eleven municipalities of 213. A
   scope that is wrong is worse than a scope that is small, because the output
   looks complete. */
const text = (name: string): string | null => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : (process.argv[i + 1] ?? null);
};
const all = process.argv.includes('--all');
const provinces = (text('province') ?? '').split(',').map((p) => p.trim().toUpperCase()).filter(Boolean);

if (!all && provinces.length === 0) {
  console.error('Give a scope: --province GT  (or GT,KZN)  or --all for the whole register.');
  console.error('--all is ~213 municipalities x 8 issues, about an hour of polite requests.');
  await pool.end();
  process.exit(1);
}

const { rows: municipalities } = await pool.query<{ demarcation_code: string; name: string }>(
  `SELECT demarcation_code, name FROM municipality
    WHERE category <> 'C'
      AND ($1::boolean OR province_code = ANY($2::text[]))
    ORDER BY name`, [all, provinces]);

if (municipalities.length === 0) {
  /* Two different failures used to share one message. An empty register and
     a mistyped province code are not the same problem, and telling someone
     to re-run the register load when they typed 'GP' instead of 'GT' sends
     them to fix something that is not broken. */
  const { rows: any } = await pool.query<{ n: string }>('SELECT count(*) AS n FROM municipality');
  if (Number(any[0]?.n ?? 0) === 0) {
    console.error('No municipalities loaded. Run: npm run sources:official -- 2023 2024');
  } else {
    const { rows: codes } = await pool.query<{ province_code: string }>(
      'SELECT DISTINCT province_code FROM municipality WHERE province_code IS NOT NULL ORDER BY 1');
    console.error(`No municipality has province code ${provinces.join(', ')}.`);
    console.error(`Codes in the register: ${codes.map((c) => c.province_code).join(', ')}`);
  }
  await pool.end();
  process.exit(1);
}

const categories = Object.keys(CATEGORY_TERMS) as IssueCategory[];
const client = new NewsClient();

const requests = municipalities.length * categories.length;
console.log(`Reading ${municipalities.length} municipalities x ${categories.length} issues, `
  + `last ${days} days, scored by ${scorer.name}`);
console.log(`${requests} requests at ~1.5s apart — about ${Math.ceil(requests * 1.5 / 60)} minutes.`);

const { run } = await recorded('google_news', async (c) => {
  let seen = 0;
  let kept = 0;

  for (const m of municipalities) {
    for (const category of categories) {
      let found;
      try {
        found = await client.search(m.name, m.demarcation_code, category, days);
      } catch (error) {
        // One failed query should not lose the whole sweep; the run record
        // keeps the count so a partial read is visible as a partial read.
        console.error(`  ${m.name} / ${category}: ${(error as Error).message}`);
        continue;
      }
      seen += found.seen;
      if (found.items.length === 0) continue;

      // Headlines enter the scorer here and are gone after it. The only
      // thing that reaches the database is a count and a score.
      const result = await ingest(
        c,
        found.items.map((i) => ({
          text: i.text, placeId: i.demarcationCode, observedOn: i.observedOn,
          category: i.category,
        })),
        scorer, 'google_news',
        'https://news.google.com/rss/search',
        'MUNICIPALITY');
      kept += result.signals;
    }
    process.stdout.write(`  ${m.name}: ${kept} signals so far\n`);
  }
  return { result: kept, seen, kept };
});

if (run.ok) {
  console.log(`\nok — ${run.itemsSeen} headlines read, ${run.itemsKept} signal rows written`);
  const { rows } = await pool.query(
    `SELECT source, geo_level::text AS level, count(*)::int AS rows,
            sum(mentions)::int AS mentions, min(observed_on) AS from_day,
            max(observed_on) AS to_day
       FROM issue_signal GROUP BY source, geo_level ORDER BY source`);
  console.table(rows);
} else {
  console.error(`failed — ${run.error}`);
}

await pool.end();
process.exit(run.ok ? 0 : 1);
