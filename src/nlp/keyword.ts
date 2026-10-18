import type { IssueCategory, ScoredItem, Scorer, Tone } from './types.js';

/* A lexicon scorer: no dependencies, no model download, no API key.
 *
 * WHY THIS EXISTS. So the pipeline is end-to-end runnable on day one and the
 * rest of the system can be tested against something real. It is a baseline
 * and a fallback, not the answer - it reports confidence around 0.4 and the
 * sentiment screen shows that number for exactly this reason.
 *
 * WHAT IT CANNOT DO. Sarcasm, negation at any distance ("not a single outage
 * in a month" scores negative), and the languages this corpus is actually
 * written in. Gauteng service-delivery talk is English, isiZulu, Sesotho,
 * Setswana, Afrikaans and a good deal of code-switching inside single
 * sentences. The terms below are overwhelmingly English and the handful of
 * borrowed words do not fix that. Treat non-English wards as under-counted
 * until a multilingual model is in place - that under-count is not random,
 * it tracks language, which tracks demography.
 */

const CATEGORY_TERMS: Record<IssueCategory, string[]> = {
  Electricity: ['load shedding', 'loadshedding', 'load-shedding', 'stage 4', 'stage 6',
    'eskom', 'city power', 'power cut', 'power outage', 'no power', 'no electricity',
    'blackout', 'transformer', 'cable theft', 'prepaid electricity', 'substation'],
  Water: ['no water', 'water outage', 'water cut', 'rand water', 'johannesburg water',
    'joburg water', 'burst pipe', 'water leak', 'water tanker', 'jojo', 'dry taps',
    'low pressure', 'water shedding', 'reservoir'],
  Sanitation: ['sewage', 'sewer', 'drain', 'blocked drain', 'manhole', 'effluent',
    'toilet', 'vip toilet', 'waste water', 'spillage', 'overflow'],
  Refuse: ['refuse', 'rubbish', 'bins', 'bin', 'pikitup', 'illegal dumping', 'dumping',
    'waste collection', 'uncollected', 'landfill', 'litter'],
  Roads: ['pothole', 'potholes', 'road closed', 'robots not working', 'robot not working',
    'traffic light', 'street light', 'streetlight', 'gravel road', 'speed bump', 'tarring'],
  Housing: ['rdp', 'rdp house', 'housing list', 'title deed', 'informal settlement',
    'shack', 'backyard', 'eviction', 'hostel', 'waiting list'],
  Safety: ['crime', 'hijack', 'robbery', 'shooting', 'gang', 'cpf', 'police station',
    'patrol', 'break-in', 'mugging', 'zama zama', 'kidnapping'],
  Health: ['clinic', 'hospital', 'medicine', 'ambulance', 'nurse', 'queue at the clinic',
    'no medication', 'chronic meds'],
  Transport: ['taxi', 'bus', 'rea vaya', 'gautrain', 'metrobus', 'putco', 'train',
    'prasa', 'commute', 'fare'],
  Billing: ['municipal bill', 'billing', 'overcharged', 'estimate reading', 'meter reading',
    'prepaid meter', 'arrears', 'disconnection', 'cut off for non-payment', 'rates and taxes',
    'account statement'],
  Other: [],
};

/* Tone markers. Order matters: Mobilising is checked first because an angry
 * post that also calls a march is operationally a mobilising post - the
 * campaign cares what it leads to, not how loud it is. */
const TONE_TERMS: Array<[Tone, string[]]> = [
  ['Mobilising', ['protest', 'march', 'shutdown', 'picket', 'memorandum', 'petition',
    'join us', 'we must', 'meeting at', 'mass action', 'vote them out', 'take to the streets',
    'community meeting', 'stand together', 'enough is enough']],
  ['Angry', ['disgusting', 'disgrace', 'fed up', 'sick and tired', 'useless', 'corrupt',
    'thieves', 'pathetic', 'unacceptable', 'outrageous', 'shameful', 'incompetent']],
  ['Resigned', ['as usual', 'nothing new', 'same old', 'no point', 'gave up', 'given up',
    'nobody cares', 'no one cares', 'what else is new', 'typical', 'used to it',
    'never going to change']],
];

const POSITIVE = ['fixed', 'restored', 'resolved', 'thank you', 'thanks', 'working again',
  'back on', 'sorted', 'well done', 'appreciated', 'prompt', 'quick response'];
const NEGATIVE = ['still no', 'again', 'third day', 'weeks without', 'months without',
  'no response', 'ignored', 'promised', 'nothing', 'failed', 'broken', 'worse',
  'dangerous', 'unsafe', 'stinks', 'overflowing'];

/* Bare nouns, worth less than a phrase. Without these, "community meeting
 * about the water" and "water finally restored" both fall through to Other,
 * because every Water phrase above is a complaint phrase - which quietly
 * meant the lexicon could only see a service when someone was angry about it.
 * Weighted below the phrases so "water bill" still reads as Billing. */
const CATEGORY_NOUNS: Partial<Record<IssueCategory, string[]>> = {
  Electricity: ['electricity', 'power', 'eskom'],
  Water: ['water', 'tap', 'taps'],
  Sanitation: ['sanitation', 'sewerage'],
  Refuse: ['refuse', 'garbage', 'waste'],
  Roads: ['road', 'roads', 'pavement'],
  Housing: ['housing', 'house'],
  Safety: ['safety', 'police', 'security'],
  Health: ['clinic', 'hospital'],
  Transport: ['transport', 'taxi', 'bus'],
  Billing: ['bill', 'account', 'tariff'],
};

const PHRASE_WEIGHT = 2;
const NOUN_WEIGHT = 1;

const count = (haystack: string, needles: string[]) =>
  needles.reduce((n, term) => (haystack.includes(term) ? n + 1 : n), 0);

export class KeywordScorer implements Scorer {
  readonly name = 'keyword-v1';

  async score(texts: string[]): Promise<ScoredItem[]> {
    return texts.map((raw) => {
      const t = raw.toLowerCase();

      let category: IssueCategory = 'Other';
      let best = 0;
      for (const [cat, terms] of Object.entries(CATEGORY_TERMS) as Array<[IssueCategory, string[]]>) {
        const score = count(t, terms) * PHRASE_WEIGHT
          + count(t, CATEGORY_NOUNS[cat] ?? []) * NOUN_WEIGHT;
        if (score > best) { best = score; category = cat; }
      }

      const pos = count(t, POSITIVE);
      const neg = count(t, NEGATIVE);
      // Unmatched text is not neutral-with-confidence, it is unknown: fall to
      // a mild negative because the corpus is complaints, and say so with a
      // low confidence rather than pretending to a reading.
      const polarity = pos + neg === 0
        ? -0.2
        : Math.max(-1, Math.min(1, (pos - neg) / (pos + neg)));

      // OPEN QUESTION for the model, not for the scorer to settle. The tone
      // enum is an ordinal of unhappiness - Resigned, Frustrated, Angry,
      // Mobilising - and has no value meaning "satisfied". So a post saying
      // the water came back and thanking the crew is forced to Resigned,
      // which is the least activated label but reads as the wrong thing.
      // Either tone gains a fifth value, or it is accepted as meaningful
      // only on negative items. Until that is decided, positives land here.
      let tone: Tone = polarity > 0.2 ? 'Resigned' : 'Frustrated';
      for (const [candidate, terms] of TONE_TERMS) {
        if (count(t, terms) > 0) { tone = candidate; break; }
      }

      // Confidence tracks how much actually matched, and is capped well below
      // 1: a lexicon never earns high confidence on open-ended text.
      const matched = best + pos + neg;
      const confidence = Math.min(0.55, 0.15 + matched * 0.1);

      return { category, polarity: Number(polarity.toFixed(3)), tone, confidence };
    });
  }
}
