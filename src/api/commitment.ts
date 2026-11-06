/* The commitment chain, served.
 *
 * Reads v_commitment_chain, which masks counts and nonce until a link is
 * revealed (migration 055). That masking is the only reason this endpoint can
 * be left open to anyone who can see the app: a sealed tally is readable in
 * the table and must not leave the server.
 *
 * Columns are listed explicitly. `SELECT *` here would publish a sealed
 * tally the first time someone adds a column to the view - the same rule
 * that keeps capture_token and reporter phone numbers out of payloads.
 */

import { pool } from '../db.js';
import { json, type Ctx } from './http.js';
import { verifyChain, type PartyCount } from '../tally/commit.js';

interface Row {
  seq: number;
  scope: string;
  scope_key: string;
  taken_at: Date;
  slips_captured: number;
  slips_expected: number;
  coverage_pct: number | null;
  prev_digest: string;
  digest: string;
  counts: PartyCount[] | null;
  nonce: string | null;
  parties: number;
  committed_at: Date;
  revealed_at: Date | null;
  note: string | null;
  revealed: boolean;
  links_to_previous: boolean;
  anchored_at: Date | null;
  anchored_to: string | null;
  anchor_recorded: boolean;
  covered_by_anchor: boolean;
}

export async function getCommitments(ctx: Ctx): Promise<void> {
  const { rows } = await pool.query<Row>(
    `SELECT seq, scope, scope_key, taken_at, slips_captured, slips_expected,
            coverage_pct, prev_digest, digest, counts, nonce, parties,
            committed_at, revealed_at, note, revealed, links_to_previous,
            anchored_at, anchored_to, anchor_recorded, covered_by_anchor
       FROM v_commitment_chain
      ORDER BY seq DESC
      LIMIT 200`);

  /* Recomputed server-side so the page does not have to carry a sha256
     implementation, and so the answer is the same one `npm run tally:verify`
     gives. The chain is verified oldest-first regardless of display order. */
  const ordered = [...rows].sort((a, b) => a.seq - b.seq);
  const problems = verifyChain(ordered.map((r) => ({
    seq: r.seq, digest: r.digest, prev_digest: r.prev_digest,
    scope: r.scope, scope_key: r.scope_key, taken_at: r.taken_at,
    slips_captured: r.slips_captured, slips_expected: r.slips_expected,
    nonce: r.nonce, counts: r.counts,
  })));

  const revealed = rows.filter((r) => r.revealed).length;
  const broken = new Set(problems.map((p) => p.seq));

  json(ctx.res, 200, {
    data: {
      links: rows.map((r) => ({
        seq: r.seq,
        scope: r.scope,
        scope_key: r.scope_key || null,
        taken_at: r.taken_at,
        slips_counted: r.slips_captured,
        slips_expected: r.slips_expected,
        coverage_pct: r.coverage_pct,
        digest: r.digest,
        prev_digest: r.prev_digest,
        parties: r.parties,
        revealed: r.revealed,
        revealed_at: r.revealed_at,
        // Null while sealed. The view withholds them, not this handler.
        counts: r.counts,
        nonce: r.nonce,
        note: r.note,
        /* The operator's own note that this digest was sent. A POINTER, not
           proof - see migration 056. The UI must never render it as a
           verification, only as "go and find this message". */
        anchor_recorded: r.anchor_recorded,
        anchored_to: r.anchored_to,
        anchored_at: r.anchored_at,
        covered_by_anchor: r.covered_by_anchor,
        ok: !broken.has(r.seq),
        problems: problems.filter((p) => p.seq === r.seq).map((p) => p.detail),
      })),
      summary: {
        links: rows.length,
        revealed,
        sealed: rows.length - revealed,
        problems: problems.length,
        /* Named for what it is. A clean chain is self-consistent; it is not
           proof against whoever owns the database, who could rebuild it so
           that it verifies. Only a digest published elsewhere settles that,
           which is why the UI shows the newest digest for copying rather
           than a green tick on its own. */
        self_consistent: problems.length === 0,
        digests_recomputed: revealed,
      },
    },
  });
}
