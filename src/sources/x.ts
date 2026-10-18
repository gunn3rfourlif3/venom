import type { RawItem } from '../nlp/types.js';

/* X, via the v2 API.
 *
 * MONEY FIRST, because this is the only source in Venom that bills by the
 * item. X moved to pay-per-use credits: there are no tiers and no monthly
 * allowance, and a read costs USD 0.005 per post RETURNED - not per request.
 * Ten thousand posts is about USD 50. A broad query left on a schedule is a
 * standing order against the campaign's bank account, so this client refuses
 * to run without a budget and stops when it reaches it.
 *
 * Re-fetching the same post within the same UTC day is charged once, so a
 * sweep that overlaps yesterday is cheaper than it looks. That is not a
 * reason to over-fetch.
 *
 * As with Reddit, nothing identifying is kept: the text goes to the scorer,
 * a count comes back, and the post is gone. No author, no handle, no
 * conversation id, no quote.
 */

/** USD per post returned, as published on the X API pricing page. */
export const COST_PER_POST_USD = 0.005;

export interface XOptions {
  bearerToken: string;
  /** Hard ceiling in USD for this run. Required: there is no safe default. */
  budgetUsd: number;
  userAgent?: string;
}

interface XSearchResponse {
  data?: Array<{ id: string; text: string; created_at?: string }>;
  meta?: { next_token?: string; result_count?: number };
}

export class XBudgetExceeded extends Error {
  constructor(readonly spentUsd: number, readonly budgetUsd: number) {
    super(`X budget reached: USD ${spentUsd.toFixed(2)} of ${budgetUsd.toFixed(2)}`);
    this.name = 'XBudgetExceeded';
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class XClient {
  private spentUsd = 0;

  constructor(private readonly options: XOptions) {
    if (!(options.budgetUsd > 0)) {
      throw new Error('XClient needs a positive budgetUsd: reads are billed per post returned');
    }
  }

  /** What this client has spent so far, for source_run.cost_usd. */
  get spent(): number { return Number(this.spentUsd.toFixed(4)); }

  /** Recent search, paged until the budget, the page cap or the data runs out.
   *
   *  `maxPosts` is a second ceiling on top of the budget so a caller can be
   *  specific about volume as well as spend; whichever binds first wins. */
  async searchRecent(
    query: string, wardId: string, maxPosts = 500,
  ): Promise<{ items: RawItem[]; seen: number; costUsd: number }> {
    const items: RawItem[] = [];
    let seen = 0;
    let nextToken: string | undefined;

    while (seen < maxPosts) {
      const remainingBudgetPosts =
        Math.floor((this.options.budgetUsd - this.spentUsd) / COST_PER_POST_USD);
      if (remainingBudgetPosts <= 0) {
        if (items.length === 0) throw new XBudgetExceeded(this.spentUsd, this.options.budgetUsd);
        break;
      }

      const pageSize = Math.max(10, Math.min(100, maxPosts - seen, remainingBudgetPosts));
      const url = new URL('https://api.x.com/2/tweets/search/recent');
      url.searchParams.set('query', query);
      url.searchParams.set('max_results', String(pageSize));
      url.searchParams.set('tweet.fields', 'created_at');
      if (nextToken) url.searchParams.set('next_token', nextToken);

      const response = await fetch(url, {
        headers: {
          authorization: `Bearer ${this.options.bearerToken}`,
          'user-agent': this.options.userAgent ?? 'venom/0.1',
        },
        signal: AbortSignal.timeout(30_000),
      });

      if (response.status === 429) {
        const reset = Number(response.headers.get('x-rate-limit-reset') ?? '0');
        const waitMs = reset > 0
          ? Math.max(1000, reset * 1000 - Date.now())
          : 60_000;
        await sleep(Math.min(15 * 60_000, waitMs));
        continue;
      }
      if (response.status === 402 || response.status === 403) {
        throw new Error(
          `X refused the request (HTTP ${response.status}). Out of credits, or the ` +
          'query uses an operator this account cannot access.');
      }
      if (!response.ok) throw new Error(`X search failed: HTTP ${response.status}`);

      const body = await response.json() as XSearchResponse;
      const posts = body.data ?? [];

      // Charged on what came back, so the meter moves before anything is kept.
      this.spentUsd += posts.length * COST_PER_POST_USD;
      seen += posts.length;

      for (const post of posts) {
        const text = post.text.trim();
        if (text === '') continue;
        items.push({
          text,
          wardId,
          observedOn: (post.created_at ?? new Date().toISOString()).slice(0, 10),
        });
      }

      nextToken = body.meta?.next_token;
      if (!nextToken || posts.length === 0) break;
    }

    return { items, seen, costUsd: this.spent };
  }
}
