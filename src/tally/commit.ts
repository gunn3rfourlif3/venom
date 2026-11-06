/* Tamper-evident tally commitments.
 *
 * WHAT THIS IS FOR. Publishing a running count invites one question that no
 * amount of dashboard polish answers: how does anyone know the number you
 * showed at 20:15 is the number you are standing behind at 23:00? A
 * commitment answers it. The digest goes out when the count is taken; the
 * count and its nonce go out at the end; anyone can recompute the digest and
 * see the two match.
 *
 * WHAT IT IS NOT FOR, AND THIS MATTERS. It does not hide which party a
 * number belongs to. That was the original idea and it does not survive
 * contact with reality: the IEC posts each station's result at the station,
 * so the ground truth is already public and any anonymous feed can be joined
 * to it. Encryption hides a label; it cannot hide the shape of the data, and
 * with election results the shape is the identity. This module therefore
 * does the opposite - it makes the numbers MORE checkable, not less.
 *
 * THE LIMIT OF A SELF-HELD COMMITMENT. A chain held entirely by the party
 * that made it proves nothing against that party: whoever can write the
 * payload can rewrite the digest beside it. Two things give it teeth, and
 * both are built here:
 *
 *   1. The chain. Each digest includes the previous one, so altering any
 *      entry invalidates every entry after it. You cannot quietly edit
 *      20:15 and leave 23:00 standing.
 *   2. External anchoring. `tally:export` emits one short line to publish
 *      somewhere you do not control - an email to an observer, a post, a
 *      message to a journalist. Once seq 7's digest exists outside your
 *      database, entries 1..7 are frozen for everyone, including you.
 *
 * Without step 2 this is an integrity check against accident and against
 * someone else tampering. With it, it is evidence.
 *
 * THE CANONICAL FORM IS DELIBERATELY BORING. Plain text, one field per
 * line, parties sorted by name, votes as integers. Not JSON: key order,
 * whitespace and number formatting are all unspecified enough in JSON that
 * two correct implementations can disagree, and a digest that depends on
 * whose serialiser you used is not a digest anyone can check. A person with
 * sha256sum and a text editor can verify this by hand.
 */

import { createHash, randomBytes } from 'node:crypto';

export const COMMIT_VERSION = 'xnith-tally-v1';

/** The digest every chain starts from. */
export const GENESIS = '0'.repeat(64);

export interface PartyCount {
  party: string;
  votes: number;
}

export interface TallySnapshot {
  seq: number;
  /** NATIONAL | PROVINCE | MUNICIPALITY */
  scope: string;
  /** Province name or demarcation code; empty for NATIONAL. */
  scopeKey: string;
  /** ISO 8601, to the second. Millisecond drift must not change a digest. */
  takenAt: string;
  counts: PartyCount[];
  /** Slips behind the counts, so a digest pins its own coverage. */
  slipsCaptured: number;
  slipsExpected: number;
}

/** Fixed to the second: a timestamp that keeps milliseconds would make the
 *  digest depend on how fast the machine was, which is not a fact about the
 *  tally. */
export function canonicalTime(d: Date | string): string {
  const t = typeof d === 'string' ? new Date(d) : d;
  return `${t.toISOString().slice(0, 19)}Z`;
}

/* Party names come from transcribed ballot papers and could carry a tab or a
   newline, which would let one field bleed into the next and make two
   different tallies share a digest. Escaped rather than stripped: the name
   must still round-trip for the reveal to be checkable. */
function escapeField(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n');
}

/**
 * The exact bytes that get hashed. Returned rather than hidden so it can be
 * printed, inspected and checked by hand with `sha256sum`.
 */
export function canonicalForm(
  snap: TallySnapshot, prevDigest: string, nonce: string,
): string {
  if (!/^[0-9a-f]{64}$/.test(prevDigest)) {
    throw new Error(`prevDigest must be 64 lowercase hex characters`);
  }
  if (!/^[0-9a-f]{32,}$/.test(nonce)) {
    throw new Error('nonce must be at least 32 lowercase hex characters');
  }
  if (!Number.isInteger(snap.seq) || snap.seq < 1) {
    throw new Error('seq must be a positive integer');
  }

  const counts = [...snap.counts].sort((a, b) => a.party.localeCompare(b.party, 'en'));
  for (const c of counts) {
    if (!Number.isInteger(c.votes) || c.votes < 0) {
      throw new Error(`votes for ${c.party} must be a non-negative integer`);
    }
  }
  // A party appearing twice would make the total ambiguous.
  const seen = new Set<string>();
  for (const c of counts) {
    if (seen.has(c.party)) throw new Error(`party ${c.party} appears twice`);
    seen.add(c.party);
  }

  const lines = [
    COMMIT_VERSION,
    `seq\t${snap.seq}`,
    `scope\t${escapeField(snap.scope)}`,
    `key\t${escapeField(snap.scopeKey)}`,
    `taken\t${canonicalTime(snap.takenAt)}`,
    `slips\t${snap.slipsCaptured}\t${snap.slipsExpected}`,
    `prev\t${prevDigest}`,
    `parties\t${counts.length}`,
    ...counts.map((c) => `vote\t${escapeField(c.party)}\t${c.votes}`),
    `nonce\t${nonce}`,
    '',                      // trailing newline, so the form is line-complete
  ];
  return lines.join('\n');
}

export function digestOf(
  snap: TallySnapshot, prevDigest: string, nonce: string,
): string {
  return createHash('sha256')
    .update(canonicalForm(snap, prevDigest, nonce), 'utf8')
    .digest('hex');
}

/** 32 bytes. The nonce is what stops anyone confirming a guessed tally
 *  against a published digest before the reveal - without it, a sealed
 *  national count has few enough plausible values to simply try them. */
export function newNonce(): string {
  return randomBytes(32).toString('hex');
}

export interface ChainLink {
  seq: number;
  digest: string;
  prev_digest: string;
  scope: string;
  scope_key: string | null;
  taken_at: string | Date;
  slips_captured: number;
  slips_expected: number;
  nonce: string | null;
  counts: PartyCount[] | null;
}

export interface ChainProblem {
  seq: number;
  kind: 'order' | 'link' | 'digest' | 'sealed';
  detail: string;
}

/**
 * Recomputes a chain from its own contents.
 *
 * A sealed entry (no nonce yet) cannot be recomputed - that is the point of
 * sealing - so its digest is taken as given and only its position in the
 * chain is checked. Everything revealed is recomputed in full.
 */
export function verifyChain(links: ChainLink[]): ChainProblem[] {
  const problems: ChainProblem[] = [];
  const ordered = [...links].sort((a, b) => a.seq - b.seq);
  let expectedPrev = GENESIS;

  for (let i = 0; i < ordered.length; i++) {
    const link = ordered[i]!;

    if (link.seq !== i + 1) {
      problems.push({ seq: link.seq, kind: 'order',
        detail: `expected seq ${i + 1}, found ${link.seq} — an entry is missing or duplicated` });
    }
    if (link.prev_digest !== expectedPrev) {
      problems.push({ seq: link.seq, kind: 'link',
        detail: `prev_digest ${link.prev_digest.slice(0, 12)}… does not match `
          + `the previous entry's digest ${expectedPrev.slice(0, 12)}…` });
    }

    if (link.nonce && link.counts) {
      const recomputed = digestOf({
        seq: link.seq, scope: link.scope, scopeKey: link.scope_key ?? '',
        takenAt: canonicalTime(link.taken_at as string),
        counts: link.counts,
        slipsCaptured: link.slips_captured,
        slipsExpected: link.slips_expected,
      }, link.prev_digest, link.nonce);

      if (recomputed !== link.digest) {
        problems.push({ seq: link.seq, kind: 'digest',
          detail: `recomputes to ${recomputed.slice(0, 12)}… but the chain `
            + `records ${link.digest.slice(0, 12)}… — the counts, the time or `
            + `the nonce changed after the commitment was made` });
      }
    } else if (link.nonce || link.counts) {
      problems.push({ seq: link.seq, kind: 'sealed',
        detail: 'half revealed — a reveal must publish the counts and the nonce together' });
    }

    expectedPrev = link.digest;
  }
  return problems;
}
