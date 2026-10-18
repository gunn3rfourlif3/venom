import type { RawItem } from '../nlp/types.js';

/* Reddit, via the official Data API.
 *
 * Free, but not anonymous: OAuth is mandatory and Reddit blocks unidentified
 * traffic outright rather than rate-limiting it. 100 queries per minute per
 * client ID, averaged over ten minutes, so bursts are fine and a steady hammer
 * is not. The User-Agent format is prescribed and enforced.
 *
 * Read the Data API Terms before switching this on for a campaign. Free
 * access is granted for a set of uses; commercial use is a different
 * conversation with Reddit, and "we are not selling anything" is not the test.
 *
 * WHAT COMES BACK. Post titles and selftext from public subreddits. This
 * client hands them straight to the aggregator and keeps nothing: no author,
 * no permalink against a person, no comment threads. Comments are where the
 * identifying detail lives and this client does not fetch them.
 */

export interface RedditCredentials {
  clientId: string;
  clientSecret: string;
  /** Reddit requires <platform>:<app id>:<version> (by /u/<username>). */
  userAgent: string;
}

export interface RedditQuery {
  subreddit: string;
  /** Search terms, e.g. 'water outage' OR 'no water'. */
  query: string;
  /** hour | day | week | month | year | all */
  time?: string;
  limit?: number;
}

interface RedditListing {
  data?: {
    children?: Array<{ data?: { title?: string; selftext?: string; created_utc?: number } }>;
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class RedditClient {
  private token?: string;
  private tokenExpiresAt = 0;

  constructor(private readonly credentials: RedditCredentials) {
    if (!/^[^:]+:[^:]+:[^ ]+ \(by \/u\/.+\)$/.test(credentials.userAgent)) {
      // Fail at construction rather than on the first blocked request, which
      // comes back as a bare 429 and reads like a rate limit.
      throw new Error(
        'Reddit User-Agent must be "<platform>:<app id>:<version> (by /u/<username>)"');
    }
  }

  private async authorise(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;

    const basic = Buffer
      .from(`${this.credentials.clientId}:${this.credentials.clientSecret}`)
      .toString('base64');

    const response = await fetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': this.credentials.userAgent,
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      throw new Error(`Reddit auth failed: HTTP ${response.status}`);
    }

    const body = await response.json() as { access_token: string; expires_in: number };
    this.token = body.access_token;
    // Refresh a minute early so a long sweep does not die mid-way.
    this.tokenExpiresAt = Date.now() + (body.expires_in - 60) * 1000;
    return this.token;
  }

  /** One search. Returns items ready for the aggregator; the caller supplies
   *  the ward, because Reddit has no reliable geography below subreddit and
   *  guessing one from a post would be inventing data. */
  async search(q: RedditQuery, wardId: string): Promise<{ items: RawItem[]; seen: number }> {
    const token = await this.authorise();
    const url = new URL(`https://oauth.reddit.com/r/${encodeURIComponent(q.subreddit)}/search`);
    url.searchParams.set('q', q.query);
    url.searchParams.set('restrict_sr', 'true');
    url.searchParams.set('sort', 'new');
    url.searchParams.set('t', q.time ?? 'week');
    url.searchParams.set('limit', String(Math.min(100, q.limit ?? 100)));

    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, 'user-agent': this.credentials.userAgent },
      signal: AbortSignal.timeout(30_000),
    });

    if (response.status === 429) {
      const reset = Number(response.headers.get('x-ratelimit-reset') ?? '60');
      await sleep(Math.min(120_000, (reset + 1) * 1000));
      return this.search(q, wardId);
    }
    if (!response.ok) throw new Error(`Reddit search failed: HTTP ${response.status}`);

    const body = await response.json() as RedditListing;
    const children = body.data?.children ?? [];

    const items: RawItem[] = [];
    for (const child of children) {
      const post = child.data;
      if (!post) continue;
      const text = [post.title ?? '', post.selftext ?? ''].join('\n').trim();
      if (text === '') continue;
      items.push({
        text,
        wardId,
        observedOn: new Date((post.created_utc ?? Date.now() / 1000) * 1000)
          .toISOString().slice(0, 10),
      });
    }
    return { items, seen: children.length };
  }
}
