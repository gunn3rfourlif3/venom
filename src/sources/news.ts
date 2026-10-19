import type { IssueCategory } from '../nlp/types.js';

/* News coverage as a signal, from Google News RSS.
 *
 * WHAT THIS MEASURES, said plainly: how much press attention an issue is
 * getting in a municipality. It is NOT what residents think. A week of
 * headlines about Emfuleni sewage means the story is live, not that the
 * public mood has been sampled. The source register carries that sentence in
 * its `measures` column and the screen prints it, because the gap between
 * "coverage" and "opinion" is exactly where a tool like this misleads people.
 *
 * It is, though, real: dated, attributed, and checkable against the outlet
 * that published it. That is a better foundation than invented numbers.
 *
 * WHAT IT STORES. Counts and scores per municipality, category and day.
 * Headlines go to the scorer in memory and are dropped. There is no headline
 * text, no byline and no URL-per-item in the database, for the same reason
 * there is no post text: the boundary is the same one.
 *
 * GEOGRAPHY. Municipality level, never ward. Migration 020 exists precisely
 * so this can be stored truthfully rather than spread across wards.
 */

const ENDPOINT = 'https://news.google.com/rss/search';

/** Search terms per category, in the words South African coverage uses.
 *  "Load shedding" is not a phrase anyone outside this country types, and
 *  "refuse removal" is what a municipality calls what a resident calls bins. */
export const CATEGORY_TERMS: Partial<Record<IssueCategory, string>> = {
  Water:       'water outage OR "no water" OR "burst pipe" OR "water supply"',
  Electricity: 'electricity OR "load shedding" OR "power outage" OR "City Power"',
  Refuse:      '"refuse removal" OR "illegal dumping" OR "waste collection"',
  Sanitation:  'sewage OR sanitation OR "sewer spill"',
  Roads:       'potholes OR "road repairs" OR "street lights"',
  Housing:     'housing OR "informal settlement" OR "RDP houses"',
  Safety:      'crime OR policing OR "community safety"',
  Billing:     '"municipal billing" OR "electricity tariff" OR "rates and taxes"',
};

export interface NewsItem {
  /** Headline. Goes to the scorer and is then dropped. */
  text: string;
  observedOn: string;       // ISO date
  demarcationCode: string;
  category: IssueCategory;
  outlet: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Minimal RSS reading. A dependency-free regex pass is enough here because
 *  the only fields taken are title, date and source, and anything that fails
 *  to parse is skipped rather than guessed at. */
function parseItems(xml: string): Array<{ title: string; date: string; outlet: string | null }> {
  const out: Array<{ title: string; date: string; outlet: string | null }> = [];
  for (const block of xml.match(/<item>[\s\S]*?<\/item>/g) ?? []) {
    const title = /<title>([\s\S]*?)<\/title>/.exec(block)?.[1];
    const date = /<pubDate>([\s\S]*?)<\/pubDate>/.exec(block)?.[1];
    const outlet = /<source[^>]*>([\s\S]*?)<\/source>/.exec(block)?.[1] ?? null;
    if (!title || !date) continue;
    out.push({ title: decode(title), date, outlet: outlet ? decode(outlet) : null });
  }
  return out;
}

const decode = (s: string) => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&amp;/g, '&')
  .trim();

export class NewsClient {
  constructor(
    /** Google asks that automated readers go gently. One query at a time,
     *  with a pause between: the whole Gauteng sweep is about 70 requests. */
    private readonly pauseMs = 1500,
    private readonly userAgent = 'venom/0.1 (ward analytics; contact via repo)',
  ) {}

  private async fetchFeed(query: string): Promise<string> {
    const url = `${ENDPOINT}?q=${encodeURIComponent(query)}&hl=en-ZA&gl=ZA&ceid=ZA:en`;
    const response = await fetch(url, {
      headers: { 'user-agent': this.userAgent, accept: 'application/rss+xml, application/xml' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Google News returned HTTP ${response.status}`);
    return response.text();
  }

  /** One municipality, one category. The municipality name goes into the
   *  query verbatim, so attribution is the publisher's, not ours: if the
   *  story does not name the place, it does not come back. */
  async search(
    municipalityName: string, demarcationCode: string,
    category: IssueCategory, sinceDays: number,
  ): Promise<{ items: NewsItem[]; seen: number }> {
    const terms = CATEGORY_TERMS[category];
    if (!terms) return { items: [], seen: 0 };

    const xml = await this.fetchFeed(`"${municipalityName}" (${terms})`);
    const raw = parseItems(xml);
    const cutoff = Date.now() - sinceDays * 86_400_000;

    const items: NewsItem[] = [];
    for (const r of raw) {
      const when = Date.parse(r.date);
      if (!Number.isFinite(when) || when < cutoff) continue;
      items.push({
        text: r.title,
        observedOn: new Date(when).toISOString().slice(0, 10),
        demarcationCode,
        category,
        outlet: r.outlet,
      });
    }
    await sleep(this.pauseMs);
    return { items, seen: raw.length };
  }
}
