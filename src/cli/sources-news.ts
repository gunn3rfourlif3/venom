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
 * One query per ward-holding municipality per category, so a Gauteng sweep
 * is about seventy requests at a second and a half apart: roughly two
 * minutes, which is the polite speed for a free public feed.
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

const { rows: municipalities } = await pool.query<{ demarcation_code: string; name: string }>(
  `SELECT demarcation_code, name FROM municipality
    WHERE category <> 'C' AND province_code = 'GT' ORDER BY name`);

if (municipalities.length === 0) {
  console.error('No municipalities loaded. Run: npm run sources:official -- 2023 2024');
  await pool.end();
  process.exit(1);
}

const categories = Object.keys(CATEGORY_TERMS) as IssueCategory[];
const client = new NewsClient();

console.log(`Reading ${municipalities.length} municipalities x ${categories.length} issues, `
  + `last ${days} days, scored by ${scorer.name}`);

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
