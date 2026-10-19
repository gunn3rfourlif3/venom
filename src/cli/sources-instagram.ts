import { pool } from '../db.js';
import { recorded } from '../sources/promote.js';
import {
  InstagramClient, InstagramQuotaExceeded, dueHashtags, quotaUsed, recordQuery,
  HASHTAG_CAP, CAP_WINDOW_DAYS,
} from '../sources/instagram.js';
import { KeywordScorer } from '../nlp/keyword.js';
import { LocalModelScorer } from '../nlp/local.js';
import { ingest } from '../sentiment/aggregate.js';
import type { Scorer } from '../nlp/types.js';

/* Reads the curated Instagram hashtags.
 *
 *   npm run sources:instagram
 *   npm run sources:instagram -- --days 14 --model
 *
 * Needs IG_ACCESS_TOKEN and IG_USER_ID in .env, from a Business or Creator
 * account with App Review for Instagram Public Content Access. Without them
 * this prints what is missing and exits, rather than failing inside a fetch.
 *
 * The quota is checked BEFORE anything is fetched. Thirty unique hashtags
 * per seven days is easy to burn by accident, and burning it leaves the
 * source unusable for a week.
 */

const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(`--${name}`);
  const v = i === -1 ? NaN : Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : fallback;
};

const token = process.env['IG_ACCESS_TOKEN'];
const userId = process.env['IG_USER_ID'];

if (!token || !userId) {
  console.error('Instagram is not connected.\n');
  console.error('  Needs IG_ACCESS_TOKEN and IG_USER_ID in .env, from an Instagram');
  console.error('  Business or Creator account whose app has passed App Review for');
  console.error('  the Instagram Public Content Access feature and instagram_basic.');
  console.error('\n  Until then the Sources screen shows Instagram as not connected,');
  console.error('  which is what it is.');
  await pool.end();
  process.exit(1);
}

const days = arg('days', 28);
const scorer: Scorer = process.argv.includes('--model')
  ? new LocalModelScorer() : new KeywordScorer();

const client = new InstagramClient({ accessToken: token, userId });

const probe = await pool.connect();
const tags = await dueHashtags(probe);
const used = await quotaUsed(probe);
probe.release();

if (tags.length === 0) {
  console.error('No hashtag in instagram_hashtag names a municipality and is enabled.');
  console.error('A tag that names no place cannot be attributed to one, so it is not read.');
  await pool.end();
  process.exit(1);
}

// Tags already inside the window do not cost again; only new ones do.
const fresh = tags.filter((t) =>
  !t.last_queried_at
  || Date.now() - new Date(t.last_queried_at).getTime() > CAP_WINDOW_DAYS * 86_400_000);

if (used + fresh.length > HASHTAG_CAP) {
  const error = new InstagramQuotaExceeded(used, fresh.length);
  console.error(error.message);
  console.error('\nDisable some tags in instagram_hashtag, or wait for the window to roll.');
  await pool.end();
  process.exit(1);
}

console.log(`Reading ${tags.length} hashtags, last ${days} days, scored by ${scorer.name}`);
console.log(`Quota: ${used} of ${HASHTAG_CAP} used, this run adds ${fresh.length}`);

const { run } = await recorded('instagram', async (c) => {
  let seen = 0;
  let kept = 0;

  for (const tag of tags) {
    try {
      const id = tag.hashtag_id ?? await client.hashtagId(tag.tag);
      if (!id) {
        await recordQuery(c, tag.tag, null, 0);
        console.log(`  #${tag.tag}: no such hashtag`);
        continue;
      }

      const media = await client.recentMedia(id, days);
      seen += media.length;
      await recordQuery(c, tag.tag, id, media.length);

      if (media.length === 0) { console.log(`  #${tag.tag}: nothing recent`); continue; }

      // Captions go to the scorer and are dropped. The category comes from
      // the curated list, not from the classifier: the tag is why the post
      // was fetched, which is a fact rather than a guess.
      const result = await ingest(
        c,
        media.map((m) => ({
          text: m.caption,
          placeId: tag.demarcation_code!,
          observedOn: m.observedOn,
          category: tag.category!,
        })),
        scorer, 'instagram',
        'https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/hashtag-search',
        'MUNICIPALITY');

      kept += result.signals;
      console.log(`  #${tag.tag}: ${media.length} posts, ${result.signals} signal rows`);
    } catch (error) {
      // One tag failing should not lose the rest, and the ledger still
      // records the attempt so the quota maths stays honest.
      console.error(`  #${tag.tag}: ${(error as Error).message}`);
    }
  }
  return { result: kept, seen, kept };
});

console.log(run.ok
  ? `\nok — ${run.itemsSeen} posts read, ${run.itemsKept} signal rows written`
  : `\nfailed — ${run.error}`);

await pool.end();
process.exit(run.ok ? 0 : 1);
