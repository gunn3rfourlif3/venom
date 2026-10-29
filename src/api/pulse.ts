/* The Overview's live panel: a national map and an activity strip.
 *
 * TWO JOBS, SIX DAYS APART. Before polling day the question is "are we
 * ready" and the map shows staffing filling in. On the day the question is
 * "what is happening right now" and the same map shows result slips
 * arriving. One component, switched by the election date on control_panel,
 * so the thing being stared at under pressure on 4 November is the thing
 * everyone has been looking at all week.
 *
 * WHY THE MODE IS NOT A USER TOGGLE BY DEFAULT. A toggle left in the wrong
 * position on election night shows a staffing map to a room that thinks it
 * is watching results come in. The date decides; the client may override for
 * a rehearsal, and when it does the panel says which mode it is in.
 *
 * THE ACTIVITY STRIP IS NOT A MAP, DELIBERATELY. A map answers "where". It
 * cannot answer "is this working at all", which is the question at 14:00
 * when the room has been quiet for twenty minutes. Three counts per
 * ten-minute bucket - slips, reports, alerts - answer it in a strip that
 * costs almost no vertical space.
 */

import { pool } from '../db.js';
import { json } from './http.js';
import type { Ctx } from './http.js';

/* Buckets of ten minutes over the last hour. Generated rather than derived
   from the rows, so a quiet period renders as a run of zeros instead of
   disappearing - an empty stretch IS the signal here. */
const BUCKETS = 6;
const BUCKET_MIN = 10;

const RATE_WINDOW_MIN = 30;
const QUIET_AFTER_MIN = 40;

/* ---------------------------------------------------------- blocks
 *
 * The panel's optional sections. Each is computed only when the client asks
 * for it, via ?blocks=rate,provinces,...
 *
 * THAT IS NOT PREMATURE OPTIMISATION, IT IS THE POINT. This endpoint is
 * re-read on every NOTIFY, which on polling night means whenever a slip
 * lands. Computing a province rollup and a seat projection for a panel
 * nobody has open would turn the one screen that must stay responsive into
 * the thing generating the load. A section switched off costs one `if`.
 */

/** Slips per minute over the recent window, and what that implies. */
async function rateBlock(province: string | null) {
  const { rows: [r] } = await pool.query<{
    recent: number; window_min: number; expected: number; captured: number;
  }>(
    `SELECT (SELECT count(*)::int FROM result_slip rs
              JOIN station st ON st.station_id = rs.station_id
              JOIN ward w ON w.ward_id = st.ward_id
              JOIN municipality m ON m.demarcation_code = w.demarcation_code
             WHERE rs.captured_at >= now() - ($1 || ' minutes')::interval
               AND rs.rejected IS NULL
               AND ($2::text IS NULL OR m.province_name = $2))  AS recent,
            $1::int                                             AS window_min,
            COALESCE(sum(ballots_expected), 0)::int             AS expected,
            COALESCE(sum(ballots_captured), 0)::int             AS captured
       FROM v_station_readiness
      WHERE ($2::text IS NULL OR province = $2)`,
    [RATE_WINDOW_MIN, province]);

  const perMin = (r?.recent ?? 0) / RATE_WINDOW_MIN;
  const remaining = Math.max(0, (r?.expected ?? 0) - (r?.captured ?? 0));

  /* No ETA from a zero rate. "Infinity minutes" and a blank are both wrong;
     the honest answer is that nothing is arriving, which is itself the
     finding someone watching this panel needs. */
  const minutesLeft = perMin > 0 ? Math.round(remaining / perMin) : null;

  return {
    window_min: RATE_WINDOW_MIN,
    recent: r?.recent ?? 0,
    per_minute: Number(perMin.toFixed(2)),
    remaining,
    minutes_left: minutesLeft,
    eta: minutesLeft === null ? null
      : new Date(Date.now() + minutesLeft * 60000).toISOString(),
  };
}

/** Per province: how much is in, and when it last heard anything. */
async function provinceBlock() {
  const { rows } = await pool.query(
    `SELECT province,
            count(*) FILTER (WHERE is_real)::int                AS stations,
            count(*) FILTER (WHERE is_real
                               AND ballots_captured > 0)::int   AS reporting,
            count(*) FILTER (WHERE is_real
                               AND readiness = 'staffed')::int  AS staffed,
            COALESCE(sum(ballots_expected), 0)::int             AS expected,
            COALESCE(sum(ballots_captured), 0)::int             AS captured
       FROM v_station_readiness
      WHERE province IS NOT NULL
      GROUP BY province ORDER BY province`);

  /* Last activity per province, separately: a LEFT JOIN onto the aggregate
     above would multiply the station rows by the slip rows and inflate every
     count in it. */
  const { rows: last } = await pool.query(
    `SELECT m.province_name AS province, max(rs.captured_at) AS last_slip
       FROM result_slip rs
       JOIN station st ON st.station_id = rs.station_id
       JOIN ward w ON w.ward_id = st.ward_id
       JOIN municipality m ON m.demarcation_code = w.demarcation_code
      WHERE rs.rejected IS NULL
      GROUP BY m.province_name`);
  const lastBy = new Map(last.map((r) => [r.province, r.last_slip]));

  return rows.map((r) => ({
    ...r,
    pct: r.expected > 0 ? Math.round((r.captured / r.expected) * 100) : null,
    last_slip: lastBy.get(r.province) ?? null,
  }));
}

/** The last few exceptions, as text. A count is not actionable; a list is. */
async function exceptionBlock() {
  const { rows } = await pool.query(
    /* No reporter_phone, no acknowledged_by - an exception feed is read on a
       shared screen and does not need to carry a volunteer's number. */
    `SELECT a.alert_id, a.kind, a.severity, a.body, a.value,
            a.raised_at, a.acknowledged_at, a.station_id,
            st.name AS station_name, m.province_name AS province
       FROM alert a
       LEFT JOIN station st ON st.station_id = a.station_id
       LEFT JOIN ward w ON w.ward_id = st.ward_id
       LEFT JOIN municipality m ON m.demarcation_code = w.demarcation_code
      ORDER BY a.raised_at DESC
      LIMIT 6`);
  return rows;
}

/** Seats, where a council can actually be projected. */
async function seatBlock() {
  const { rows: [counts] } = await pool.query<{
    projectable: number; waiting: number; needs_total: number;
  }>(
    `SELECT count(*) FILTER (WHERE status = 'projectable')::int       AS projectable,
            count(*) FILTER (WHERE status = 'ready - waiting for results')::int AS waiting,
            count(*) FILTER (WHERE status = 'needs council seat total')::int    AS needs_total
       FROM v_seat_readiness`);
  const { rows: declared } = await pool.query(
    `SELECT demarcation_code, municipality, province, total_seats, slips_captured
       FROM v_seat_readiness
      WHERE status = 'projectable'
      ORDER BY slips_captured DESC LIMIT 5`);
  return { ...counts, declared };
}

/** Provinces that have gone quiet while others are still arriving. */
function quietFrom(provinces: Array<{ province: string; last_slip: string | null;
                                      reporting: number }>) {
  const seen = provinces
    .map((p) => (p.last_slip ? Date.parse(p.last_slip) : null))
    .filter((t): t is number => t !== null);
  if (!seen.length) return { quiet: [], newest: null };

  const newest = Math.max(...seen);
  /* Quiet means quiet RELATIVE to the rest of the country. Measuring against
     wall-clock time would flag every province at 03:00 when counting is
     simply over, and flag none at 20:00 when one has genuinely stalled. */
  return {
    newest: new Date(newest).toISOString(),
    quiet: provinces
      .filter((p) => p.reporting > 0 && p.last_slip
        && newest - Date.parse(p.last_slip) > QUIET_AFTER_MIN * 60000)
      .map((p) => ({
        province: p.province,
        last_slip: p.last_slip,
        silent_min: Math.round((newest - Date.parse(p.last_slip!)) / 60000),
      })),
  };
}

export async function getPulse(ctx: Ctx): Promise<void> {
  const { rows: [panel] } = await pool.query<{
    election_date: string | null; days_to: number | null;
  }>(
    `SELECT election_date,
            (election_date - CURRENT_DATE)::int AS days_to
       FROM control_panel`);

  const override = ctx.url.searchParams.get('mode');
  const auto = (panel?.days_to ?? 99) <= 0 ? 'capture' : 'staffing';
  const mode = override === 'capture' || override === 'staffing' ? override : auto;
  const province = ctx.url.searchParams.get('province');

  /* Packed parallel arrays, the same shape the readiness map uses: the whole
     country in one response rather than 23,696 JSON objects. */
  const rows = await pool.query<{ y: number; x: number; code: string;
                                  province: string | null }>(
    mode === 'capture'
      ? `SELECT round(latitude::numeric  * 1000)::int AS y,
                round(longitude::numeric * 1000)::int AS x,
                CASE
                  WHEN NOT is_real                              THEN '1'
                  WHEN ballots_captured >= ballots_expected
                       AND ballots_expected > 0                 THEN '3'
                  WHEN ballots_captured > 0                     THEN '2'
                  ELSE '0'
                END AS code,
                province
           FROM v_station_readiness
          WHERE ($1::text IS NULL OR province = $1)`
      : `SELECT round(latitude::numeric  * 1000)::int AS y,
                round(longitude::numeric * 1000)::int AS x,
                CASE
                  WHEN NOT is_real                     THEN '1'
                  WHEN readiness = 'staffed'           THEN '3'
                  WHEN readiness = 'people_only'       THEN '2'
                  ELSE '0'
                END AS code,
                province
           FROM v_station_readiness
          WHERE ($1::text IS NULL OR province = $1)`,
    [province]);

  const { rows: [totals] } = await pool.query(
    `SELECT count(*) FILTER (WHERE is_real)::int                 AS stations,
            count(*) FILTER (WHERE is_real
                               AND readiness = 'staffed')::int   AS staffed,
            sum(ballots_expected)::int                           AS slips_expected,
            sum(ballots_captured)::int                           AS slips_captured,
            count(*) FILTER (WHERE is_real
                               AND ballots_captured > 0)::int    AS stations_reporting
       FROM v_station_readiness
      WHERE ($1::text IS NULL OR province = $1)`, [province]);

  /* generate_series makes the empty buckets exist. Counting rows alone would
     return nothing for a quiet ten minutes, and the strip would silently
     compress time - the gap would vanish rather than show as a flat run,
     which is the opposite of what someone watching for a stall needs. */
  const activity = await pool.query(
    `WITH anchor AS (
       -- The start of the bucket the current moment falls in.
       SELECT date_trunc('hour', now())
              + ((floor(extract(minute FROM now())::int / $1) * $1)
                 * interval '1 minute') AS cur
     ),
     buckets AS (
       -- Exactly $2 buckets ending at the current one. Counting backwards
       -- from the anchor rather than forwards from a computed start, which
       -- is what the first version got wrong: it produced however many
       -- buckets happened to fit, which was 2.
       SELECT a.cur - (i * $1) * interval '1 minute' AS t
         FROM anchor a, generate_series($2 - 1, 0, -1) AS i
     )
     SELECT to_char(b.t, 'HH24:MI') AS at,
            (SELECT count(*)::int FROM result_slip rs
              WHERE rs.captured_at >= b.t
                AND rs.captured_at <  b.t + ($1 || ' minutes')::interval) AS slips,
            (SELECT count(*)::int FROM booth_report br
              WHERE br.reported_at >= b.t
                AND br.reported_at <  b.t + ($1 || ' minutes')::interval) AS reports,
            (SELECT count(*)::int FROM alert a
              WHERE a.raised_at >= b.t
                AND a.raised_at <  b.t + ($1 || ' minutes')::interval) AS alerts
       FROM buckets b ORDER BY b.t`,
    [BUCKET_MIN, BUCKETS]);

  /* Stable, sorted, and sent once. The per-point string indexes into it. */
  const provinceNames = [...new Set(rows.rows
    .map((r) => r.province).filter((p): p is string => Boolean(p)))].sort();

  /* Only what the client has switched on. */
  const want = new Set((ctx.url.searchParams.get('blocks') ?? '')
    .split(',').map((b) => b.trim()).filter(Boolean));
  const extra: Record<string, unknown> = {};

  if (want.has('rate')) extra.rate = await rateBlock(province);
  if (want.has('provinces') || want.has('quiet')) {
    const provs = await provinceBlock();
    if (want.has('provinces')) extra.provinces = provs;
    if (want.has('quiet')) extra.quiet = quietFrom(provs as never);
  }
  if (want.has('exceptions')) extra.exceptions = await exceptionBlock();
  if (want.has('seats')) extra.seats = await seatBlock();

  json(ctx.res, 200, {
    mode,
    mode_source: override ? 'override' : 'election date',
    election_date: panel?.election_date ?? null,
    days_to_election: panel?.days_to ?? null,
    scale: 1000,
    y: rows.rows.map((r) => r.y),
    x: rows.rows.map((r) => r.x),
    state: rows.rows.map((r) => r.code).join(''),
    /* One character per point, indexing `province_names` below. The map
       needs to know which province a dot belongs to so hovering can read
       one out and clicking can focus it; shipping the province NAME per
       point would add roughly 300 kB of repeated strings to a payload whose
       whole design is to avoid exactly that. Nine provinces fit in a digit. */
    /* `prov`, NOT `provinces`. The optional Provinces section is spread into
       this response as `provinces`, and being spread later it overwrote this
       string with that array - every hover then compared a character against
       an object and matched nothing, so the map silently stopped responding
       to the pointer while rendering perfectly. */
    prov: rows.rows.map((r) =>
      String(Math.max(0, provinceNames.indexOf(r.province ?? '')))).join(''),
    province_names: provinceNames,
    totals: totals ?? null,
    activity: activity.rows,
    ...extra,
    as_of: new Date().toISOString(),
  });
}
