import type { PoolClient } from 'pg';
import type { IssueCategory, Scorer } from '../nlp/types.js';

/* Gauteng community newspapers, over open RSS.
 *
 * THE DIFFERENCE FROM news.ts. There, one query is sent per category, so the
 * category is known before anything comes back. Here a single mixed feed
 * arrives - crime, sport, a night market, a water outage - and most of it is
 * not a service-delivery signal at all. So this source has to do something
 * the other does not: decide what is relevant before deciding what it is
 * about, and throw the rest away.
 *
 * That filter is the whole quality of this source. "Local artist escapes
 * life challenges through art" is a good story and not a grievance, and
 * filing it under Other with a mildly negative score would be noise dressed
 * as signal.
 */

export interface PressTitle {
  domain: string;
  label: string;
  demarcation_code: string;
  language: string;
}

export interface PressItem {
  text: string;
  observedOn: string;
  demarcationCode: string;
  category: IssueCategory;
}

/* The relevance test, and the categoriser, in one pass. Phrases are weighted
 * above bare nouns for the same reason as in the lexicon scorer: "water
 * bill" is Billing, not Water. A score below the floor means the item is not
 * about a municipal service and is dropped rather than filed. */
const PHRASES: Record<string, string[]> = {
  Water:       ['no water', 'water outage', 'water cut', 'burst pipe', 'water leak',
                'water supply', 'dry taps', 'water tanker', 'reservoir', 'rand water',
                'geen water', 'wateronderbreking'],
  Electricity: ['load shedding', 'loadshedding', 'power outage', 'power cut', 'no electricity',
                'eskom', 'city power', 'substation', 'cable theft', 'transformer',
                'beurtkrag', 'kragonderbreking'],
  Refuse:      ['refuse removal', 'illegal dumping', 'waste collection', 'uncollected',
                'pikitup', 'landfill', 'rubbish', 'vullis'],
  Sanitation:  ['sewage', 'sewer', 'blocked drain', 'manhole', 'effluent', 'spillage',
                'riool'],
  Roads:       ['pothole', 'potholes', 'road repairs', 'street light', 'streetlight',
                'traffic light', 'robots not working', 'slaggat'],
  Housing:     ['informal settlement', 'rdp house', 'title deed', 'housing list',
                'eviction', 'backyard dweller', 'behuising'],
  Safety:      ['hijack', 'robbery', 'shooting', 'cash-in-transit', 'cpf', 'police station',
                'break-in', 'mugging', 'kidnapping', 'misdaad'],
  Billing:     ['municipal bill', 'billing', 'overcharged', 'prepaid meter', 'meter reading',
                'arrears', 'disconnection', 'rates and taxes', 'tariff'],
};

const NOUNS: Record<string, string[]> = {
  Water: ['water'], Electricity: ['electricity', 'power'], Refuse: ['refuse', 'waste'],
  Sanitation: ['sanitation', 'sewerage'], Roads: ['road', 'roads'],
  Housing: ['housing'], Safety: ['crime', 'police'], Billing: ['tariff', 'rates'],
};

/** Below this, the item is not about a municipal service. A phrase scores 2
 *  and a bare noun 1, so the floor of 2 means one real phrase, or two
 *  supporting nouns - never a single incidental word. */
export const RELEVANCE_FLOOR = 2;

export function classify(text: string): { category: IssueCategory; score: number } | null {
  const low = text.toLowerCase();
  let best: IssueCategory | null = null;
  let bestScore = 0;

  for (const category of Object.keys(PHRASES) as IssueCategory[]) {
    const phrases = (PHRASES[category] ?? []).filter((p) => low.includes(p)).length;
    const nouns = (NOUNS[category] ?? []).filter((n) => new RegExp(`\\b${n}\\b`).test(low)).length;
    const score = phrases * 2 + nouns;
    if (score > bestScore) { bestScore = score; best = category; }
  }
  return best && bestScore >= RELEVANCE_FLOOR ? { category: best, score: bestScore } : null;
}

const decode = (s: string) => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#8217;|&#39;/g, "'")
  .replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ')
  .trim();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class LocalPressClient {
  constructor(
    private readonly pauseMs = 900,
    private readonly userAgent = 'venom/0.1 (ward analytics; contact via repo)',
  ) {}

  /** One title's feed. Title and description are read together, because a
   *  headline alone often names the suburb and not the service. */
  async read(
    title: PressTitle, sinceDays: number,
  ): Promise<{ items: PressItem[]; seen: number; kept: number }> {
    const response = await fetch(`https://${title.domain}/feed/`, {
      headers: { 'user-agent': this.userAgent, accept: 'application/rss+xml, application/xml' },
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`${title.domain}: HTTP ${response.status}`);

    const xml = await response.text();
    const blocks = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
    const cutoff = Date.now() - sinceDays * 86_400_000;

    const items: PressItem[] = [];
    for (const block of blocks) {
      const headline = /<title>([\s\S]*?)<\/title>/.exec(block)?.[1];
      const summary = /<description>([\s\S]*?)<\/description>/.exec(block)?.[1] ?? '';
      const date = /<pubDate>([\s\S]*?)<\/pubDate>/.exec(block)?.[1];
      if (!headline || !date) continue;

      const when = Date.parse(date);
      if (!Number.isFinite(when) || when < cutoff) continue;

      const text = `${decode(headline)}. ${decode(summary)}`.trim();
      const hit = classify(text);
      // Not about a municipal service: dropped, not filed as Other.
      if (!hit) continue;

      items.push({
        text,
        observedOn: new Date(when).toISOString().slice(0, 10),
        demarcationCode: title.demarcation_code,
        category: hit.category,
      });
    }

    await sleep(this.pauseMs);
    return { items, seen: blocks.length, kept: items.length };
  }
}

export async function enabledTitles(client: PoolClient): Promise<PressTitle[]> {
  const { rows } = await client.query<PressTitle>(
    `SELECT p.domain, p.label, p.demarcation_code, p.language
       FROM press_title p
       JOIN municipality m USING (demarcation_code)
      WHERE p.enabled
      ORDER BY m.name, p.label`);
  return rows;
}

export async function recordFetch(
  client: PoolClient, domain: string, itemCount: number,
): Promise<void> {
  await client.query(
    `UPDATE press_title SET last_fetched_at = now(), last_item_count = $2
      WHERE domain = $1`, [domain, itemCount]);
}

export type { Scorer };
