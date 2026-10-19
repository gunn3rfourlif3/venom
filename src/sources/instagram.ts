import type { PoolClient } from 'pg';
import type { IssueCategory } from '../nlp/types.js';

/* Instagram, via Hashtag Search on the Graph API.
 *
 * TWO THINGS THIS FILE EXISTS TO GET RIGHT.
 *
 * The quota. Thirty unique hashtags per account per rolling seven days, each
 * counted from its first query, and the clock does not reset on a repeat.
 * Resolving a hashtag's id costs a query, and so does every call to
 * recent_media. So the ids are cached, the ledger is persisted in
 * instagram_hashtag, and the client refuses to start a run that would exceed
 * the cap rather than discovering it halfway through as an API error.
 *
 * The username. Hashtag results carry `username`, and this is the source in
 * Venom most likely to breach the issues-not-people boundary by accident:
 * the field is simply there, and `fields=` defaulting to everything is one
 * careless edit away. So the field list is explicit, it is a constant, and
 * there is an assertion that it contains nothing identifying. A caption is
 * read, scored, and dropped like every other text in this system; a handle
 * is never read at all.
 *
 * WHAT IT MEASURES. How much a hashtag is being posted under. That is not
 * public opinion and it is not even coverage - it is one platform's posting
 * volume on a tag someone chose. Useful as a pulse, weak as evidence, and
 * the source register says so.
 *
 * NOT TESTED AGAINST THE LIVE API. Instagram Hashtag Search needs a Business
 * account and App Review that this project does not yet have, so this code
 * has never run against Instagram. It is written from the published contract
 * and should be treated as unproven until a token exists.
 */

const GRAPH = 'https://graph.facebook.com/v21.0';

/* Explicit, and deliberately short. `username`, `permalink` and `media_url`
 * are all available and all identify an account or a person; none are here.
 * `caption` is the only text, and it goes to the scorer and no further. */
export const MEDIA_FIELDS = ['id', 'timestamp', 'caption', 'like_count', 'comments_count'] as const;

const IDENTIFYING = ['username', 'owner', 'permalink', 'media_url', 'thumbnail_url', 'shortcode'];
for (const field of MEDIA_FIELDS) {
  if (IDENTIFYING.includes(field)) {
    // Thrown at import, not at runtime: a field list that identifies people
    // should stop the process before it can fetch anything.
    throw new Error(`instagram: ${field} identifies an account and must not be requested`);
  }
}

export const HASHTAG_CAP = 30;
export const CAP_WINDOW_DAYS = 7;

export interface InstagramCredentials {
  /** A long-lived token for the Business or Creator account. */
  accessToken: string;
  /** The IG Business account id the search is performed on behalf of. */
  userId: string;
}

export interface HashtagRow {
  tag: string;
  demarcation_code: string | null;
  category: IssueCategory | null;
  hashtag_id: string | null;
  last_queried_at: Date | null;
}

export interface InstagramItem {
  text: string;
  observedOn: string;
  demarcationCode: string;
  category: IssueCategory;
}

export class InstagramQuotaExceeded extends Error {
  constructor(readonly used: number, readonly wanted: number) {
    super(`Instagram hashtag quota: ${used} of ${HASHTAG_CAP} used in the last `
      + `${CAP_WINDOW_DAYS} days, and this run needs ${wanted} more. `
      + 'A hashtag counts for seven days from its first query and the clock does not reset.');
    this.name = 'InstagramQuotaExceeded';
  }
}

export class InstagramClient {
  constructor(private readonly credentials: InstagramCredentials) {}

  private async get(path: string, params: Record<string, string>): Promise<unknown> {
    const url = new URL(`${GRAPH}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set('access_token', this.credentials.accessToken);

    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    const body = await response.json() as { error?: { message?: string; code?: number } };
    if (!response.ok || body.error) {
      throw new Error(`Instagram: ${body.error?.message ?? `HTTP ${response.status}`}`);
    }
    return body;
  }

  /** Resolve a tag to its id. Costs a query against the cap, so the caller
   *  persists the result and never asks twice. */
  async hashtagId(tag: string): Promise<string | null> {
    const body = await this.get('/ig_hashtag_search', {
      user_id: this.credentials.userId,
      q: tag,
    }) as { data?: Array<{ id: string }> };
    return body.data?.[0]?.id ?? null;
  }

  /** Recent media under a hashtag, as counts and captions only.
   *
   *  `fields` is passed explicitly every time. The API would otherwise
   *  return a default set, and defaults are how a handle ends up in a
   *  database nobody meant to put handles in. */
  async recentMedia(
    hashtagId: string, sinceDays: number,
  ): Promise<Array<{ caption: string; observedOn: string }>> {
    const body = await this.get(`/${hashtagId}/recent_media`, {
      user_id: this.credentials.userId,
      fields: MEDIA_FIELDS.join(','),
      limit: '50',
    }) as { data?: Array<{ caption?: string; timestamp?: string }> };

    const cutoff = Date.now() - sinceDays * 86_400_000;
    const out: Array<{ caption: string; observedOn: string }> = [];
    for (const media of body.data ?? []) {
      const when = Date.parse(media.timestamp ?? '');
      if (!Number.isFinite(when) || when < cutoff) continue;
      const caption = (media.caption ?? '').trim();
      // No caption means nothing to score. Counting it as a mention with a
      // neutral score would be inventing a reading of a picture nobody read.
      if (caption === '') continue;
      out.push({ caption, observedOn: new Date(when).toISOString().slice(0, 10) });
    }
    return out;
  }
}

/** Hashtags that name a municipality, are switched on, and whose quota clock
 *  has either expired or is already counted. Ordered oldest-first so a
 *  partial run rotates through the list rather than always taking the same
 *  few tags. */
export async function dueHashtags(client: PoolClient): Promise<HashtagRow[]> {
  const { rows } = await client.query<HashtagRow>(
    `SELECT tag, demarcation_code, category, hashtag_id, last_queried_at
       FROM instagram_hashtag
      WHERE enabled AND demarcation_code IS NOT NULL AND category IS NOT NULL
      ORDER BY last_queried_at NULLS FIRST, tag`);
  return rows;
}

/** How many of the thirty are already spent, counted the way Instagram
 *  counts them: a tag queried inside the window is spent, whether or not it
 *  is queried again. */
export async function quotaUsed(client: PoolClient): Promise<number> {
  const { rows } = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM instagram_hashtag
      WHERE last_queried_at > now() - ($1 || ' days')::interval`,
    [CAP_WINDOW_DAYS]);
  return Number(rows[0]?.n ?? 0);
}

export async function recordQuery(
  client: PoolClient, tag: string, hashtagId: string | null, mediaCount: number,
): Promise<void> {
  await client.query(
    `UPDATE instagram_hashtag
        SET hashtag_id = COALESCE($2, hashtag_id),
            last_queried_at = now(), last_media_count = $3
      WHERE tag = $1`,
    [tag, hashtagId, mediaCount]);
}
