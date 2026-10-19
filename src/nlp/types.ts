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
  /** The place this item is about: a ward id, or a municipality's
   *  demarcation code. Which one depends on what the source actually knows.
   *  A source that only knows the municipality says so and is stored that
   *  way, rather than having a ward guessed for it. */
  placeId: string;
  observedOn: string;   // ISO date
  /** Set when the SOURCE already knows the category and the classifier does
   *  not need to guess it. A news item returned by the water query is about
   *  water, whatever words the headline happens to use; letting a lexicon
   *  re-derive it from "Emfuleni crisis deepens" just loses the fact. */
  category?: IssueCategory;
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
