/* The scoring contract.
 *
 * THE POINT OF THIS FILE is the shape of ScoredItem: it has no text field,
 * and there is no path from a fetched post to the database that does not go
 * through it. Text enters score(), a verdict comes out, and the text is
 * unreachable from that moment on. The boundary is in the type system rather
 * than in a reviewer's memory, because "we'll remember not to store the
 * posts" is how systems end up storing the posts.
 */

export type IssueCategory =
  | 'Water' | 'Electricity' | 'Refuse' | 'Roads' | 'Housing'
  | 'Sanitation' | 'Safety' | 'Health' | 'Transport' | 'Billing' | 'Other';

/** Disposition, not polarity. Resigned and Mobilising are both unhappy; only
 *  one of them turns up to vote. See migration 017. */
export type Tone = 'Resigned' | 'Frustrated' | 'Angry' | 'Mobilising';

/** What a classifier concluded about one item. Deliberately carries no text,
 *  no author, no handle and no identifier. */
export interface ScoredItem {
  category: IssueCategory;
  /** -1 wholly negative, +1 wholly positive. */
  polarity: number;
  tone: Tone;
  /** 0..1. A scorer that does not know should say so rather than guess high. */
  confidence: number;
}

/** What a source hands to a scorer. This type never reaches the database
 *  layer: nothing in src/sentiment/ accepts it as a write argument. */
export interface RawItem {
  text: string;
  /** Resolved before scoring, from place names or the subreddit/geo hints. */
  wardId: string;
  observedOn: string;   // ISO date
}

export interface Scorer {
  readonly name: string;
  /** Batched because every real implementation is: a model forward pass and
   *  an API call both cost far more per call than per item. */
  score(texts: string[]): Promise<ScoredItem[]>;
}

export const CATEGORIES: readonly IssueCategory[] = [
  'Water', 'Electricity', 'Refuse', 'Roads', 'Housing',
  'Sanitation', 'Safety', 'Health', 'Transport', 'Billing', 'Other',
];
