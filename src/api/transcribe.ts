/**
 * Transcription — turning a photograph into numbers, twice.
 *
 * The rule this file exists to enforce: **the second pass is blind.** If the
 * screen shows the second operator what the first one typed, they will read
 * it, agree with it, and the whole exercise becomes a ritual that produces
 * false confidence. Double entry only detects anything if the two people
 * cannot see each other's answers.
 *
 * What the second operator IS given is the list of party names the first
 * recorded — not the votes. The names are printed on the slip in front of
 * them, so this reveals nothing, and it keeps the two passes keyed to the
 * same rows so that a comparison is possible at all. They can also add a line
 * the first pass missed, because an omitted party is exactly the error this
 * is for, and pre-filling alone would hide it.
 */

import { pool } from '../db.js';
import { HttpError, json, readJson, type Ctx } from './http.js';
import { requireRole } from './auth.js';
import { normalise } from '../ingest/parties.js';

interface SlipRow {
  slip_id: string;
  station_id: string;
  ballot: string;
  name: string;
  municipality: string;
  ward_id: string;
  passes: number;
}

/**
 * GET /api/transcribe/next — hand this operator a slip to type.
 *
 * Slips needing a first pass come before slips needing a second, so the
 * queue drains breadth-first: on election night a thousand slips each with
 * one pass is a far better position than five hundred finished and five
 * hundred untouched, because the first pass is what makes a count exist at
 * all.
 */
export async function getNext(ctx: Ctx): Promise<void> {
  requireRole(ctx, 'reporter');
  const me = ctx.userId ?? 'unknown';

  const { rows } = await pool.query<SlipRow>(
    `SELECT c.slip_id, c.station_id, c.ballot, s.name, w.municipality, w.ward_id,
            (SELECT count(*) FROM result_transcription t WHERE t.slip_id = c.slip_id)::int
              AS passes
       FROM v_slip_current c
       JOIN station s ON s.station_id = c.station_id
       JOIN ward w    ON w.ward_id = s.ward_id
      WHERE (SELECT count(*) FROM result_transcription t WHERE t.slip_id = c.slip_id) < 2
        -- never the same operator twice on one slip: that is one pair of eyes
        -- entering the same number twice, which is not a check.
        AND NOT EXISTS (SELECT 1 FROM result_transcription t
                         WHERE t.slip_id = c.slip_id AND t.entered_by = $1)
      ORDER BY passes ASC, c.captured_at ASC
      LIMIT 1`, [me]);

  const slip = rows[0];
  if (!slip) {
    json(ctx.res, 200, { data: { slip: null, remaining: 0 } });
    return;
  }

  /* Party names from the first pass, WITHOUT the votes. */
  const { rows: parties } = slip.passes === 0 ? { rows: [] } : await pool.query<{ party: string }>(
    `SELECT DISTINCT v.party
       FROM result_transcription t
       JOIN result_vote v USING (transcription_id)
      WHERE t.slip_id = $1
      ORDER BY v.party`, [slip.slip_id]);

  const { rows: left } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM v_slip_current c
      WHERE (SELECT count(*) FROM result_transcription t WHERE t.slip_id = c.slip_id) < 2`);

  json(ctx.res, 200, {
    data: {
      slip: {
        slipId: Number(slip.slip_id),
        stationId: slip.station_id,
        ballot: slip.ballot,
        stationName: slip.name,
        municipality: slip.municipality,
        ward: slip.ward_id,
        pass: slip.passes + 1,
        parties: parties.map((p) => p.party),
      },
      remaining: Number(left[0]?.n ?? 0),
    },
  });
}

/**
 * POST /api/transcribe — file one pass.
 */
export async function postPass(ctx: Ctx): Promise<void> {
  requireRole(ctx, 'reporter');
  const me = ctx.userId ?? 'unknown';
  const body = await readJson<{
    slipId?: number;
    spoilt?: number;
    totalVotesCast?: number;
    votes?: Array<{ party?: string; votes?: number }>;
  }>(ctx.req);

  const slipId = Number(body.slipId);
  if (!Number.isInteger(slipId) || slipId <= 0) throw new HttpError(400, 'Which slip?');

  const entries = Array.isArray(body.votes) ? body.votes : [];
  if (entries.length === 0) throw new HttpError(400, 'No party lines entered.');

  /* Party names are normalised to the same form the IEC matcher uses, so that
     "anc" and "ANC " are one row rather than two, and a comparison between
     passes is about the numbers rather than about typing. */
  const clean: Array<{ party: string; votes: number }> = [];
  for (const e of entries) {
    const party = normalise(String(e.party ?? ''));
    const votes = Number(e.votes);
    if (party === '') continue;
    if (!Number.isInteger(votes) || votes < 0) {
      throw new HttpError(400, `"${e.party}" has no valid vote count.`);
    }
    clean.push({ party, votes });
  }
  if (clean.length === 0) throw new HttpError(400, 'No party lines entered.');

  const seen = new Set(clean.map((c) => c.party));
  if (seen.size !== clean.length) {
    throw new HttpError(400, 'The same party appears twice.');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: already } = await client.query<{ pass: number; entered_by: string }>(
      'SELECT pass, entered_by FROM result_transcription WHERE slip_id = $1 ORDER BY pass',
      [slipId]);

    if (already.length >= 2) throw new HttpError(409, 'This slip already has two passes.');
    if (already.some((a) => a.entered_by === me)) {
      /* Re-checked here rather than relying on getNext having filtered it:
         the queue is a suggestion, the transaction is the rule. */
      throw new HttpError(409, 'You have already transcribed this slip.');
    }

    const pass = already.length + 1;
    const { rows: t } = await client.query<{ transcription_id: string }>(
      `INSERT INTO result_transcription
         (slip_id, pass, entered_by, spoilt, total_votes_cast)
       VALUES ($1,$2,$3,$4,$5) RETURNING transcription_id`,
      [slipId, pass, me,
       body.spoilt === undefined || body.spoilt === null ? null : Number(body.spoilt),
       body.totalVotesCast === undefined || body.totalVotesCast === null
         ? null : Number(body.totalVotesCast)]);

    const id = t[0]!.transcription_id;
    for (const c of clean) {
      await client.query('INSERT INTO result_vote VALUES ($1,$2,$3)', [id, c.party, c.votes]);
    }

    /* Status is derived from the two passes rather than set by whoever
       happens to submit last. After one pass it is TRANSCRIBED; after two it
       is VERIFIED only if they agree on every line and on the totals. */
    let status = 'TRANSCRIBED';
    let disagreements = 0;
    if (pass === 2) {
      const { rows: d } = await client.query<{ n: string }>(
        'SELECT count(*) AS n FROM v_slip_disagreement WHERE slip_id = $1', [slipId]);
      const { rows: tot } = await client.query<{ n: string }>(
        `SELECT count(DISTINCT (spoilt, total_votes_cast)) AS n
           FROM result_transcription WHERE slip_id = $1`, [slipId]);
      disagreements = Number(d[0]?.n ?? 0) + (Number(tot[0]?.n ?? 1) > 1 ? 1 : 0);
      status = disagreements === 0 ? 'VERIFIED' : 'DISPUTED';
    }
    await client.query('UPDATE result_slip SET status = $2 WHERE slip_id = $1',
      [slipId, status]);

    await client.query('COMMIT');
    json(ctx.res, 201, { data: { slipId, pass, status, disagreements } });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * GET /api/slips/overview — coverage, and the things that need a human.
 */
export async function getOverview(ctx: Ctx): Promise<void> {
  requireRole(ctx, 'viewer');

  const [coverage, totals, disputed, recon] = await Promise.all([
    pool.query(
      `SELECT province, municipality, slips_expected, photographed, verified,
              outstanding, pct_photographed
         FROM v_slip_coverage
        WHERE photographed > 0
        ORDER BY photographed DESC, municipality
        LIMIT 60`),
    pool.query(
      `SELECT sum(slips_expected)::int AS expected,
              sum(photographed)::int   AS photographed,
              sum(verified)::int       AS verified
         FROM v_slip_coverage`),
    pool.query(
      `SELECT d.slip_id, d.station_id, d.ballot, d.party, d.pass_1, d.pass_2
         FROM v_slip_disagreement d
        ORDER BY d.station_id, d.party
        LIMIT 100`),
    pool.query(
      `SELECT station_id, ballot, pass, party_total, spoilt, total_votes_cast,
              discrepancy
         FROM v_slip_reconciliation
        WHERE discrepancy <> 0
        ORDER BY abs(discrepancy) DESC
        LIMIT 50`),
  ]);

  json(ctx.res, 200, {
    as_of: new Date().toISOString(),
    data: {
      totals: totals.rows[0] ?? { expected: 0, photographed: 0, verified: 0 },
      coverage: coverage.rows,
      disagreements: disputed.rows,
      reconciliation: recon.rows,
    },
  });
}

export const transcribe = { getNext, postPass, getOverview };
