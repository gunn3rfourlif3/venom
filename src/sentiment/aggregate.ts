import type { PoolClient } from 'pg';
import type { IssueCategory, RawItem, ScoredItem, Scorer, Tone } from '../nlp/types.js';

/* The boundary. Everything upstream of this file handles text; nothing
 * downstream of it does.
 *
 * ingest() is the only function in Venom that takes RawItem (which has a text
 * field) and the only one that writes issue_signal. In between, the items are
 * scored, counted and discarded. There is no branch, no debug flag and no
 * option that writes a post, a handle or a quote - and the schema has nowhere
 * to put one if there were.
 *
 * This is where a system like this fails if it is going to. The failure is
 * never a decision; it is someone adding a `raw_text` column to make a bug
 * easier to chase, and it never coming out again. If that column is ever
 * proposed, the answer is to improve what the scorer records about its own
 * verdict instead.
 */

/** Tie-break order for the modal tone, least to most active.
 *
 *  Deliberately asymmetric: on a tie, the more active tone wins. Calling a
 *  mobilising ward resigned loses an election; calling a resigned ward
 *  mobilising wastes a Saturday. The errors are not the same size. */
const TONE_RANK: Record<Tone, number> = {
  Resigned: 0, Frustrated: 1, Angry: 2, Mobilising: 3,
};

interface Bucket {
  /** A ward id or a demarcation code, depending on the level being written.
      Named for what it is so a municipality row cannot be mistaken for a
      ward row by a reader skimming the type. */
  placeId: string;
  category: IssueCategory;
  observedOn: string;
  mentions: number;
  weighted: number;
  weight: number;
  polaritySum: number;
  confidenceSum: number;
  tones: Map<Tone, number>;
}

const keyOf = (placeId: string, category: string, day: string) => `${placeId}|${category}|${day}`;

/** Score a batch and fold it into per-ward, per-category, per-day buckets.
 *  Exported separately from the write so it can be tested without a database
 *  and so the shape of what gets stored is inspectable. */
export async function aggregate(
  items: RawItem[], scorer: Scorer,
): Promise<Bucket[]> {
  if (items.length === 0) return [];

  const scored: ScoredItem[] = await scorer.score(items.map((i) => i.text));
  if (scored.length !== items.length) {
    throw new Error(`scorer ${scorer.name} returned ${scored.length} verdicts for ${items.length} items`);
  }

  const buckets = new Map<string, Bucket>();
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]!;
    const verdict = scored[i]!;
    // The source's own category wins where it has one: it knows which query
    // returned the item, which is a fact, where the classifier is guessing.
    const category = item.category ?? verdict.category;
    const key = keyOf(item.placeId, category, item.observedOn);

    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        placeId: item.placeId, category, observedOn: item.observedOn,
        mentions: 0, weighted: 0, weight: 0, polaritySum: 0, confidenceSum: 0,
        tones: new Map(),
      };
      buckets.set(key, bucket);
    }

    bucket.mentions += 1;
    bucket.polaritySum += verdict.polarity;
    bucket.confidenceSum += verdict.confidence;
    // Confidence-weighted, so a hundred guesses do not outvote ten readings.
    bucket.weighted += verdict.polarity * verdict.confidence;
    bucket.weight += verdict.confidence;
    bucket.tones.set(verdict.tone, (bucket.tones.get(verdict.tone) ?? 0) + 1);
  }

  // The text goes out of scope here and is never passed on.
  return [...buckets.values()];
}

function modalTone(tones: Map<Tone, number>): Tone {
  let best: Tone = 'Frustrated';
  let bestCount = -1;
  for (const [tone, n] of tones) {
    if (n > bestCount || (n === bestCount && TONE_RANK[tone] > TONE_RANK[best])) {
      best = tone; bestCount = n;
    }
  }
  return best;
}

/** Write the buckets as issue_signal rows.
 *
 *  A re-run of the same day from the same source replaces that day's figure
 *  rather than adding to it: (place, category, day, source) is one
 *  observation, and fetching twice does not mean it happened twice.
 *
 *  `level` decides which geography the row claims. A municipality-level
 *  source must not be written as ward rows - see migration 020 - so the two
 *  take different conflict targets, matching the two partial unique indexes. */
export async function writeSignals(
  client: PoolClient, buckets: Bucket[], sourceId: string,
  sourceUrl?: string, level: 'WARD' | 'MUNICIPALITY' = 'WARD',
  /* Which scorer produced these values. Stored on the row because a sentiment
     number without its scorer cannot be compared to one from a different
     lexicon, and the series is about to gain a second generation - see
     migration 042. Defaulted so an older caller still writes something true
     rather than NULL. */
  scorerName = 'keyword-v1',
): Promise<number> {
  let written = 0;
  for (const b of buckets) {
    const net = b.weight > 0 ? b.weighted / b.weight : b.polaritySum / b.mentions;
    const confidence = b.confidenceSum / b.mentions;

    const common = [
      b.category, b.observedOn, b.mentions,
      Math.max(-1, Math.min(1, Number(net.toFixed(3)))),
      modalTone(b.tones), sourceId, sourceUrl ?? null,
      Number(confidence.toFixed(3)), scorerName,
    ];

    const sql = level === 'WARD'
      ? `INSERT INTO issue_signal
           (geo_level, ward_id, category, observed_on, mentions, net_sentiment,
            tone, source, source_url, confidence, scorer)
         VALUES ('WARD', $10, $1::issue_category, $2::date, $3, $4, $5::sentiment_tone, $6, $7, $8, $9)
         ON CONFLICT (ward_id, category, observed_on, source)
           WHERE geo_level = 'WARD' DO UPDATE SET
             mentions = EXCLUDED.mentions, net_sentiment = EXCLUDED.net_sentiment,
             tone = EXCLUDED.tone, confidence = EXCLUDED.confidence,
             source_url = EXCLUDED.source_url, scorer = EXCLUDED.scorer,
             ingested_at = now()`
      : `INSERT INTO issue_signal
           (geo_level, demarcation_code, category, observed_on, mentions,
            net_sentiment, tone, source, source_url, confidence, scorer)
         VALUES ('MUNICIPALITY', $10, $1::issue_category, $2::date, $3, $4, $5::sentiment_tone, $6, $7, $8, $9)
         ON CONFLICT (demarcation_code, category, observed_on, source)
           WHERE geo_level = 'MUNICIPALITY' DO UPDATE SET
             mentions = EXCLUDED.mentions, net_sentiment = EXCLUDED.net_sentiment,
             tone = EXCLUDED.tone, confidence = EXCLUDED.confidence,
             source_url = EXCLUDED.source_url, scorer = EXCLUDED.scorer,
             ingested_at = now()`;

    const result = await client.query(sql, [...common, b.placeId]);
    written += result.rowCount ?? 0;
  }
  return written;
}

/** Fetch -> score -> count -> store, with the text never reaching the client. */
export async function ingest(
  client: PoolClient, items: RawItem[], scorer: Scorer,
  sourceId: string, sourceUrl?: string,
  level: 'WARD' | 'MUNICIPALITY' = 'WARD',
): Promise<{ buckets: number; signals: number }> {
  const buckets = await aggregate(items, scorer);
  // The scorer's own name goes onto every row it produces. It was already in
  // hand here and was only ever printed to the console (migration 042).
  const signals = await writeSignals(
    client, buckets, sourceId, sourceUrl, level, scorer.name);
  return { buckets: buckets.length, signals };
}
