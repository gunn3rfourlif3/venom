import { pool } from '../db.js';
import { recorded } from '../sources/promote.js';
import { LocalPressClient, enabledTitles, recordFetch } from '../sources/localPress.js';
import { KeywordScorer } from '../nlp/keyword.js';
import { LocalModelScorer } from '../nlp/local.js';
import { ingest } from '../sentiment/aggregate.js';
import type { Scorer } from '../nlp/types.js';

/* Reads the Gauteng community papers.
 *
 *   npm run sources:press
 *   npm run sources:press -- --days 14 --model
 *
 * No credentials. Twenty-two titles at roughly a second apart, so under a
 * minute for the lot.
 *
 * Each feed holds only its ten latest items, so this builds a series going
 * forward rather than filling one in. Run it daily and it accumulates; run
 * it once and you have one day.
 */

const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(`--${name}`);
  const v = i === -1 ? NaN : Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : fallback;
};

const days = arg('days', 30);
const scorer: Scorer = process.argv.includes('--model')
  ? new LocalModelScorer() : new KeywordScorer();

const probe = await pool.connect();
const titles = await enabledTitles(probe);
probe.release();

if (titles.length === 0) {
  console.error('No press title is enabled with a loaded municipality.');
  console.error('Run: npm run sources:official -- 2023 2024');
  await pool.end();
  process.exit(1);
}

console.log(`Reading ${titles.length} community papers, last ${days} days, `
  + `scored by ${scorer.name}`);

const client = new LocalPressClient();

const { run } = await recorded('local_press', async (c) => {
  let seen = 0;
  let kept = 0;
  let relevant = 0;

  for (const title of titles) {
    try {
      const found = await client.read(title, days);
      seen += found.seen;
      relevant += found.kept;
      await recordFetch(c, title.domain, found.seen);

      if (found.items.length === 0) {
        console.log(`  ${title.label}: ${found.seen} items, none about a service`);
        continue;
      }

      const result = await ingest(
        c,
        found.items.map((i) => ({
          text: i.text, placeId: i.demarcationCode,
          observedOn: i.observedOn, category: i.category,
        })),
        scorer, 'local_press', `https://${title.domain}/feed/`, 'MUNICIPALITY');

      kept += result.signals;
      console.log(`  ${title.label}: ${found.seen} items, ${found.kept} relevant, `
        + `${result.signals} signal rows`);
    } catch (error) {
      console.error(`  ${title.label}: ${(error as Error).message}`);
    }
  }

  console.log(`\n${relevant} of ${seen} items were about a municipal service.`);
  return { result: kept, seen, kept };
});

if (run.ok) {
  const { rows } = await pool.query(
    `SELECT source, count(*)::int AS rows, sum(mentions)::int AS mentions,
            min(observed_on) AS from_day, max(observed_on) AS to_day
       FROM issue_signal GROUP BY source ORDER BY source`);
  console.table(rows);
} else {
  console.error(`failed — ${run.error}`);
}

await pool.end();
process.exit(run.ok ? 0 : 1);
