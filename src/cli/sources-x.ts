import { pool } from '../db.js';
import { recorded } from '../sources/promote.js';
import { XClient, XBudgetExceeded, COST_PER_POST_USD } from '../sources/x.js';
import { KeywordScorer } from '../nlp/keyword.js';
import { LocalModelScorer } from '../nlp/local.js';
import { ingest } from '../sentiment/aggregate.js';
import type { Scorer, IssueCategory } from '../nlp/types.js';

/* Reads the watchlist from X.
 *
 *   npm run sources:x -- --budget 25
 *   npm run sources:x -- --budget 25 --max-per-tag 200 --model
 *
 * Needs X_BEARER_TOKEN in .env.
 *
 * THE BUDGET IS REQUIRED AND THERE IS NO DEFAULT. X bills per post returned,
 * not per request: USD 0.005 each, with no monthly allowance to absorb a
 * mistake. A broad query on a schedule is a standing order against the
 * campaign's account, so this refuses to start without a ceiling and stops
 * at it. The ceiling is in dollars because that is what X charges in; at
 * USD 25 a run reads at most 5,000 posts.
 *
 * WHAT IT READS. Recent search only - a rolling seven-day window. Full
 * archive search exists but sits behind the USD 5,000/month tier, which buys
 * history this campaign has no use for: the question is what is being said
 * now, in the fortnight before a vote, not what was said in 2019.
 *
 * WHAT IT STORES, and what it refuses to. The same boundary as every other
 * social source here. Post text goes to the scorer in memory and is dropped;
 * what is written is a count and a score per municipality, category and day.
 * No handle, no display name, no author id, no post id, no permalink, no
 * quoted text. That is not a limitation of the client - it is the reason the
 * client is shaped this way, and migration 013's CHECK constraints reject
 * anything that smuggles an identifier through anyway.
 *
 * The category comes from the watchlist entry, not from a classifier: the
 * tag is why the post was fetched, which is a fact rather than a guess.
 */

const flag = (name: string) => process.argv.includes(`--${name}`);
const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(`--${name}`);
  const v = i === -1 ? NaN : Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : fallback;
};

const token = process.env.X_BEARER_TOKEN;
if (!token) {
  console.error('X_BEARER_TOKEN is not set.');
  console.error('');
  console.error('Create an app at https://developer.x.com, then put its bearer');
  console.error('token in .env as X_BEARER_TOKEN. Reads are pay-per-use at');
  console.error(`USD ${COST_PER_POST_USD} per post returned; buy credits in the console first.`);
  await pool.end();
  process.exit(1);
}

const budgetUsd = arg('budget', NaN);
if (!(budgetUsd > 0)) {
  console.error('--budget <usd> is required and must be positive.');
  console.error('');
  console.error(`X bills USD ${COST_PER_POST_USD} per post returned, with no monthly`);
  console.error('allowance. Running without a ceiling is how a campaign discovers');
  console.error('it has spent four figures on a hashtag overnight.');
  console.error('');
  console.error('  npm run sources:x -- --budget 25      # reads at most 5,000 posts');
  await pool.end();
  process.exit(1);
}

const maxPerTag = arg('max-per-tag', 200);
const scorer: Scorer = flag('model') ? new LocalModelScorer() : new KeywordScorer();

/* Only tags that name a municipality are queried. A tag with no place cannot
   be attributed to one, and a signal row with no geography is a number with
   nowhere to go - the same rule the Instagram source applies, for the same
   reason. */
const { rows: tags } = await pool.query<{
  tag: string; demarcation_code: string; category: IssueCategory;
}>(
  `SELECT tag, demarcation_code, category::text AS category
     FROM instagram_hashtag
    WHERE enabled
      AND demarcation_code IS NOT NULL
      AND category IS NOT NULL
    ORDER BY tag`);

if (tags.length === 0) {
  console.log('No watchlist entries with a municipality. Add some on the Social');
  console.log('sentiment screen as: tag, municipality, category');
  await pool.end();
  process.exit(0);
}

const maxPosts = Math.floor(budgetUsd / COST_PER_POST_USD);
console.log(`Reading ${tags.length} watchlist tags from X, recent search (7 days)`);
console.log(`Budget USD ${budgetUsd.toFixed(2)} — at most ${maxPosts.toLocaleString('en-ZA')} posts, `
  + `up to ${maxPerTag} per tag, scored by ${scorer.name}`);

const client = new XClient({ bearerToken: token, budgetUsd, userAgent: 'xnith/1.0' });

const { run } = await recorded('x', async (c) => {
  let seen = 0;
  let kept = 0;

  for (const t of tags) {
    try {
      /* -is:retweet keeps a single post from being counted once per amplifier,
         which would otherwise bill us for the same sentence many times and
         overstate how many people are saying it. */
      const query = `#${t.tag} -is:retweet lang:en`;
      const res = await client.searchRecent(query, t.demarcation_code, maxPerTag);
      seen += res.seen;

      if (res.items.length === 0) {
        console.log(`  #${t.tag}: nothing in the last 7 days`);
        continue;
      }

      const result = await ingest(
        c,
        res.items.map((i) => ({ ...i, category: t.category })),
        scorer, 'x', 'https://docs.x.com/x-api/posts/recent-search', 'MUNICIPALITY');

      kept += result.signals;
      console.log(`  #${t.tag}: ${res.seen} posts, ${result.signals} signal rows `
        + `(USD ${client.spent.toFixed(2)} spent)`);
    } catch (error) {
      if (error instanceof XBudgetExceeded) {
        console.log(`\nStopped: ${error.message}`);
        break;
      }
      /* One tag failing should not lose the rest, and the run still records
         what it managed so the spend stays accounted for. */
      console.error(`  #${t.tag}: ${(error as Error).message}`);
    }
  }

  return { result: { seen, kept }, seen, kept, costUsd: client.spent };
});

console.log(`\n${run.ok ? 'ok' : 'failed'} — ${run.itemsSeen ?? 0} posts read, `
  + `${run.itemsKept ?? 0} signal rows written, USD ${client.spent.toFixed(2)} spent`);

await pool.end();
