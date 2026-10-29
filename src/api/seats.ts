/* Seat projection: the API in front of `src/seats/allocate.ts`.
 *
 * The engine reproduces both published 2021 results exactly. Until this file
 * existed it could not be reached from the application at all - it was a
 * validated library with nothing wired to it, and the Briefing screen listed
 * it as still to build.
 *
 * WHAT THIS REFUSES TO DO. It will not project a council whose total seat
 * count is unconfirmed, and it will not project from zero captured results.
 * Both refusals return a reason rather than an empty chart, because an empty
 * hemicycle and a hemicycle of zeros look identical on a projector and only
 * one of them is honest.
 */

import { pool } from '../db.js';
import { json } from './http.js';
import type { Ctx } from './http.js';
import { allocate } from '../seats/allocate.js';
import type { PartyVotes } from '../seats/allocate.js';
import { FIXTURES } from '../seats/fixtures.js';

/** Per council: what is still missing before a projection is possible. */
export async function getSeatReadiness(ctx: Ctx): Promise<void> {
  const province = ctx.url.searchParams.get('province');
  const rows = await pool.query(
    `SELECT demarcation_code, municipality, province, municipality_category,
            ward_seats, total_seats, seats_source, confirmed_on,
            total_if_odd, total_if_even, pr_list_loaded,
            ward_candidates_loaded, slips_captured, status
       FROM v_seat_readiness
      WHERE ($1::text IS NULL OR province = $1)
      ORDER BY ward_seats DESC, municipality`,
    [province]);

  const byStatus: Record<string, number> = {};
  for (const r of rows.rows) {
    byStatus[r.status as string] = (byStatus[r.status as string] ?? 0) + 1;
  }
  json(ctx.res, 200, { data: rows.rows, summary: byStatus });
}

/* The engine's own proof, served to the screen rather than left in a CLI.
   A projection nobody can check is a number with a chart around it; this is
   what makes the chart answerable. */
export async function getSeatValidation(ctx: Ctx): Promise<void> {
  const results = FIXTURES.map((f) => {
    const got = allocate(f.input);
    const mismatches: string[] = [];
    for (const p of got.parties) {
      const wantTotal = f.expectedTotalSeats[p.party];
      const wantPr = f.expectedPrSeats[p.party];
      if (wantTotal !== undefined && p.totalSeats !== wantTotal) {
        mismatches.push(`${p.party}: total ${p.totalSeats} vs ${wantTotal}`);
      }
      if (wantPr !== undefined && p.prSeats !== wantPr) {
        mismatches.push(`${p.party}: PR ${p.prSeats} vs ${wantPr}`);
      }
    }
    if (f.expectedQuota !== undefined && got.quota !== f.expectedQuota) {
      mismatches.push(`quota ${got.quota} vs ${f.expectedQuota}`);
    }
    return {
      name: f.name,
      quota: got.quota,
      council_seats: f.input.totalSeats,
      parties: got.parties.length,
      passed: mismatches.length === 0,
      mismatches,
      seats: got.parties
        .filter((p) => p.totalSeats > 0)
        .map((p) => ({ party: p.party, total: p.totalSeats,
                       ward: p.wardSeats, pr: p.prSeats })),
    };
  });
  json(ctx.res, 200, {
    data: results,
    all_passed: results.every((r) => r.passed),
    note: 'Published 2021 results. The engine must reproduce these exactly '
        + 'before any projection it produces is worth showing.',
  });
}

/** Projection for one council, from captured result slips. */
export async function getSeatProjection(ctx: Ctx): Promise<void> {
  const code = ctx.url.searchParams.get('municipality');
  if (!code) {
    json(ctx.res, 400, { error: 'municipality required' });
    return;
  }

  const { rows: [seats] } = await pool.query<{
    municipality: string; total_seats: number | null; ward_seats: number;
    total_if_odd: number; total_if_even: number;
  }>(
    `SELECT municipality, total_seats, ward_seats, total_if_odd, total_if_even
       FROM v_seat_readiness WHERE demarcation_code = $1`, [code]);

  if (!seats) {
    json(ctx.res, 404, { error: `no council found for ${code}` });
    return;
  }

  if (seats.total_seats === null) {
    json(ctx.res, 200, {
      projectable: false,
      municipality: seats.municipality,
      reason: 'council seat total not confirmed',
      detail: `${seats.municipality} has ${seats.ward_seats} wards, so the `
        + `council has either ${seats.total_if_odd} or ${seats.total_if_even} `
        + 'seats. Which of the two it is cannot be derived from the ward '
        + 'count, and the difference moves the quota. Confirm it from the '
        + 'Provincial Gazette notice or the IEC before projecting.',
    });
    return;
  }

  /* Votes per party per ballot, from transcriptions that were accepted.
     A rejected or superseded slip contributes nothing. `rejected` is text,
     not boolean - `rejected IS NULL` is the accepted case, and reading it as
     a boolean would have counted rejected slips as results. */
  const votes = await pool.query<{
    party: string; ballot: string; votes: string;
  }>(
    `SELECT rv.party, rs.ballot, SUM(rv.votes)::bigint AS votes
       FROM result_vote rv
       JOIN result_transcription rt ON rt.transcription_id = rv.transcription_id
       JOIN result_slip rs ON rs.slip_id = rt.slip_id
       JOIN station st ON st.station_id = rs.station_id
       JOIN ward w ON w.ward_id = st.ward_id
      WHERE w.demarcation_code = $1
        AND rs.rejected IS NULL
        AND rs.superseded IS NOT TRUE
      GROUP BY rv.party, rs.ballot`, [code]);

  if (votes.rows.length === 0) {
    json(ctx.res, 200, {
      projectable: false,
      municipality: seats.municipality,
      total_seats: seats.total_seats,
      reason: 'no results captured yet',
      detail: 'Every other input is in place. This fills in as result slips '
        + 'are captured on the night.',
    });
    return;
  }

  /* Ward seats won: per ward, the party with the most ward-ballot votes.
     Ties are left unawarded rather than broken arbitrarily - a tied ward
     goes to a recount, not to whichever party sorts first. */
  const wardWins = await pool.query<{ party: string; wards: string }>(
    `WITH per_ward AS (
       SELECT w.ward_id, rv.party, SUM(rv.votes)::bigint AS votes
         FROM result_vote rv
         JOIN result_transcription rt ON rt.transcription_id = rv.transcription_id
         JOIN result_slip rs ON rs.slip_id = rt.slip_id
         JOIN station st ON st.station_id = rs.station_id
         JOIN ward w ON w.ward_id = st.ward_id
        WHERE w.demarcation_code = $1
          AND rs.ballot = 'WARD'
          AND rs.rejected IS NULL
          AND rs.superseded IS NOT TRUE
        GROUP BY w.ward_id, rv.party
     ),
     ranked AS (
       SELECT ward_id, party, votes,
              RANK() OVER (PARTITION BY ward_id ORDER BY votes DESC) AS rnk,
              COUNT(*) FILTER (WHERE true)
                OVER (PARTITION BY ward_id ORDER BY votes DESC
                      RANGE BETWEEN CURRENT ROW AND CURRENT ROW) AS tied
         FROM per_ward
     )
     SELECT party, count(*)::bigint AS wards
       FROM ranked WHERE rnk = 1 AND tied = 1
      GROUP BY party`, [code]);

  const wardSeatsBy = new Map(
    wardWins.rows.map((r) => [r.party, Number(r.wards)]));

  const byParty = new Map<string, PartyVotes>();
  for (const r of votes.rows) {
    const p = byParty.get(r.party) ?? {
      party: r.party, wardVotes: 0, prVotes: 0,
      wardSeats: wardSeatsBy.get(r.party) ?? 0,
    };
    if (r.ballot === 'WARD') p.wardVotes += Number(r.votes);
    else p.prVotes += Number(r.votes);
    byParty.set(r.party, p);
  }

  let allocation;
  try {
    allocation = allocate({
      totalSeats: seats.total_seats,
      parties: [...byParty.values()],
    });
  } catch (error) {
    json(ctx.res, 200, {
      projectable: false,
      municipality: seats.municipality,
      reason: 'allocation failed',
      detail: (error as Error).message,
    });
    return;
  }

  json(ctx.res, 200, {
    projectable: true,
    municipality: seats.municipality,
    total_seats: seats.total_seats,
    quota: allocation.quota,
    surplus_seats: allocation.surplusSeats,
    overhang_applied: allocation.overhangApplied,
    notes: allocation.notes,
    /* PARTIAL BY CONSTRUCTION, AND SAID SO. These are the slips captured so
       far, not the declared result. The share of stations reporting is the
       number that tells a reader how much weight to put on the rest. */
    partial: true,
    data: allocation.parties,
  });
}
