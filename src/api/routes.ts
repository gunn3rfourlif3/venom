import { pool } from '../db.js';
import { terrainGrid } from '../sources/terrain.js';
import { FIELDS, readPanel, writePanel } from './controlPanel.js';
import {
  HttpError, json, readJson, intParam, wardIdParam, enumParam, type Ctx,
} from './http.js';
import {
  login, logout, authenticate, requireRole, sessionIdFrom,
  setSessionCookie, clearSessionCookie,
} from './auth.js';

const SECURE_COOKIES = process.env.NODE_ENV === 'production';

/** Every response carries as_of. A figure on screen without a timestamp is
 *  a figure nobody can defend in an argument. */
async function asOf(): Promise<string | null> {
  const result = await pool.query('SELECT max(as_of) AS as_of FROM mv_campaign_extract');
  return result.rows[0]?.as_of ?? null;
}

async function envelope(rows: unknown): Promise<Record<string, unknown>> {
  return { as_of: await asOf(), data: rows };
}

// ---------------------------------------------------------------- auth

async function postLogin(ctx: Ctx): Promise<void> {
  const body = await readJson<{ email?: string; password?: string }>(ctx.req);
  if (!body.email || !body.password) throw new HttpError(400, 'email and password required');
  const session = await login(body.email, body.password, ctx.req.headers['user-agent']);
  setSessionCookie(ctx.res, session.sessionId, SECURE_COOKIES);
  json(ctx.res, 200, {
    user_id: session.userId, role: session.role, display_name: session.displayName,
  });
}

async function postLogout(ctx: Ctx): Promise<void> {
  const sessionId = sessionIdFrom(ctx);
  if (sessionId) await logout(sessionId);
  clearSessionCookie(ctx.res, SECURE_COOKIES);
  json(ctx.res, 200, { ok: true });
}

async function getMe(ctx: Ctx): Promise<void> {
  // display_name included because the topbar shows it. Without it the client
  // falls back to user_id and greets the operator with a hex string.
  const { rows } = await pool.query<{ display_name: string }>(
    'SELECT display_name FROM app_user WHERE user_id = $1', [ctx.userId]);
  json(ctx.res, 200, {
    user_id: ctx.userId,
    role: ctx.role,
    display_name: rows[0]?.display_name ?? null,
  });
}

// ---------------------------------------------------------------- reads

/** The ranked ward list. Ordered by priority_rank, which is box first and
 *  score within box, so the top of this list is the work. */
async function getWards(ctx: Ctx): Promise<void> {
  /* The ceiling was 1000 against a national register of 4,485 wards. The
     directory loads the whole list and filters in the browser, so the cap
     silently hid 3,485 wards AND limited the municipality dropdown to
     municipalities appearing in the first 1000 by priority_rank. The
     response has always carried a true `total` from a separate count; the
     label just was not using it. Both halves are fixed. */
  const limit = intParam(ctx.url, 'limit', 100, 1, 10000);
  const offset = intParam(ctx.url, 'offset', 0, 0, 100000);
  const box = enumParam(ctx.url, 'box', ['Recruit', 'Contest', 'Hold', 'Abandon']);
  const municipality = ctx.url.searchParams.get('municipality');

  /* Province and region come from the municipality join rather than the
     extract, which carries neither. Joining here avoids rebuilding a
     materialized view that several other screens read. */
  const province = ctx.url.searchParams.get('province');
  const region = ctx.url.searchParams.get('region');

  const where = `
      WHERE ($1::text IS NULL OR x.recommended_box = $1)
        AND ($2::text IS NULL OR x.municipality = $2)
        AND ($3::text IS NULL OR m.province_name = $3)
        AND ($4::text IS NULL OR m.region_code = $4)`;

  const result = await pool.query(
    `SELECT x.*, m.province_name AS province,
            m.region_code, m.region_name, m.category AS municipality_category
       FROM mv_campaign_extract x
       JOIN ward w        ON w.ward_id = x.ward_id
       JOIN municipality m ON m.demarcation_code = w.demarcation_code
      ${where}
      ORDER BY x.priority_rank
      LIMIT $5 OFFSET $6`,
    [box, municipality, province, region, limit, offset],
  );
  const total = await pool.query(
    `SELECT count(*)::int AS n
       FROM mv_campaign_extract x
       JOIN ward w        ON w.ward_id = x.ward_id
       JOIN municipality m ON m.demarcation_code = w.demarcation_code
      ${where}`,
    [box, municipality, province, region],
  );
  json(ctx.res, 200, {
    as_of: await asOf(),
    total: total.rows[0]?.n ?? 0,
    limit, offset,
    data: result.rows,
  });
}

/** One ward in full. Reads v_ward_dossier, which goes to the views rather
 *  than the extract, so it is live rather than as-of-last-refresh. */
async function getWard(ctx: Ctx, wardId: string): Promise<void> {
  const result = await pool.query('SELECT * FROM v_ward_dossier WHERE ward_id = $1', [wardId]);
  const ward = result.rows[0];
  if (!ward) throw new HttpError(404, 'No such ward');

  const [stations, issues, decisions, documents] = await Promise.all([
    pool.query('SELECT * FROM v_booth_status WHERE ward_id = $1 ORDER BY station_id', [wardId]),
    pool.query(
      `SELECT ward_issue_id, category, severity, summary, first_seen, last_seen,
              resolved_at, evidence_url
         FROM ward_issue WHERE ward_id = $1
        ORDER BY resolved_at NULLS FIRST, severity DESC, last_seen DESC`, [wardId]),
    pool.query('SELECT * FROM v_decision_log WHERE ward_id = $1 ORDER BY taken_on DESC', [wardId]),
    pool.query(
      `SELECT d.document_id, d.title, d.kind, d.sensitivity, d.document_date
         FROM document d JOIN document_ward dw USING (document_id)
        WHERE dw.ward_id = $1
          AND (d.sensitivity <> 'Restricted' OR $2)
        ORDER BY d.document_date DESC NULLS LAST`,
      [wardId, (ctx.role === 'admin' || ctx.role === 'treasurer')]),
  ]);

  json(ctx.res, 200, {
    as_of: new Date().toISOString(),  // live, not the extract's refresh time
    data: {
      ...ward,
      stations: stations.rows,
      issues: issues.rows,
      decisions: decisions.rows,
      documents: documents.rows,
    },
  });
}

async function getTargets(ctx: Ctx): Promise<void> {
  const targetClass = enumParam(ctx.url, 'class',
    ['ACT NOW', 'WATCH', 'PRESSURE ONLY', 'QUIET']);
  /* The ceiling was 1000 against a national register of 4,485 wards, so the
     directory silently showed the first 1000 and the municipality filter
     could only offer municipalities that appeared among them. Raised past
     the register so the whole thing fits; the client is told the ceiling it
     asked for so it can say when it has hit one. */
  const limit = intParam(ctx.url, 'limit', 200, 1, 10000);
  const result = await pool.query(
    `SELECT * FROM v_ward_target
      WHERE ($1::text IS NULL OR target_class = $1)
      ORDER BY CASE target_class
                 WHEN 'ACT NOW' THEN 1 WHEN 'PRESSURE ONLY' THEN 2
                 WHEN 'WATCH' THEN 3 ELSE 4 END,
               priority_rank NULLS LAST
      LIMIT $2`,
    [targetClass, limit],
  );
  json(ctx.res, 200, await envelope(result.rows));
}

/** Trending topics for the ticker. Counts only — no article text exists. */
async function getTrending(ctx: Ctx): Promise<void> {
  const result = await pool.query(
    `SELECT municipality, province, category, recent, prior, change,
            pct_change, direction, tone
       FROM v_trending_topics
      LIMIT 24`);
  json(ctx.res, 200, await envelope(result.rows));
}

/**
 * Points for the readiness and gap maps.
 *
 * 23,751 stations as JSON objects is several megabytes and most of it is
 * repeated key names, so the payload is parallel arrays instead: latitude and
 * longitude as integers scaled by 1e4 (about 11 metres, far finer than
 * anything drawn at national zoom), and one character per station carrying
 * both its readiness and whether it is a real station.
 *
 * The counts are computed here rather than in the browser. A map that tallies
 * its own dots reports on what it managed to draw, which is not the same as
 * what exists - and the difference is exactly what a coverage figure must not
 * hide.
 */
async function getStationMap(ctx: Ctx): Promise<void> {
  const province = ctx.url.searchParams.get('province');
  const region = ctx.url.searchParams.get('region');
  const municipality = ctx.url.searchParams.get('municipality');

  const where = `WHERE ($1::text IS NULL OR province = $1)
                   AND ($2::text IS NULL OR region_code = $2)
                   AND ($3::text IS NULL OR demarcation_code = $3)`;
  const params = [province, region, municipality];

  const rows = await pool.query(
    `SELECT round(latitude::numeric  * 10000)::int AS y,
            round(longitude::numeric * 10000)::int AS x,
            readiness, is_real
       FROM v_station_readiness ${where}`, params);

  /* 0 unstaffed+real, 1 unstaffed+synthetic, 2 people_only, 3 staffed.
     Real unstaffed stations are the subject of the gap map, so they get
     their own code and are never merged with the synthetic ones. */
  const code = (r: { readiness: string; is_real: boolean }): string =>
    /* Provenance is checked FIRST and beats readiness. A synthetic station
       carrying development staffing is still synthetic, and colouring it as
       covered would draw invented coverage over a real gap - which is the
       one thing this map must never do. */
    !r.is_real ? '1'
      : r.readiness === 'staffed' ? '3'
        : r.readiness === 'people_only' ? '2'
          : '0';

  const totals = await pool.query(
    `SELECT count(*)::int                                      AS stations,
            count(*) FILTER (WHERE is_real)::int               AS real_stations,
            count(*) FILTER (WHERE readiness = 'staffed')::int AS staffed,
            count(*) FILTER (WHERE readiness = 'unstaffed'
                               AND is_real)::int               AS real_gaps,
            sum(ballots_expected)::int                         AS slips_expected,
            sum(ballots_captured)::int                         AS slips_captured,
            sum(registered_voters) FILTER (
              WHERE readiness = 'unstaffed' AND is_real)::bigint AS voters_uncovered
       FROM v_station_readiness ${where}`, params);

  /* The map carries its own place lists rather than borrowing the ward
     directory's. It is otherwise empty until that screen happens to have
     been visited, and - more importantly - these options are derived from
     the stations actually plottable, so the filter can never offer a
     province that would draw nothing. */
  const places = await pool.query(
    `SELECT DISTINCT province, region_code, region_name
       FROM v_station_readiness
      WHERE province IS NOT NULL
        AND ($1::text IS NULL OR province = $1)
      ORDER BY province, region_name`, [province]);
  const allProvinces = await pool.query(
    `SELECT DISTINCT province FROM v_station_readiness
      WHERE province IS NOT NULL ORDER BY province`);

  json(ctx.res, 200, await envelope({
    y: rows.rows.map((r) => r.y),
    x: rows.rows.map((r) => r.x),
    state: rows.rows.map(code).join(''),
    scale: 10000,
    totals: totals.rows[0] ?? null,
    provinces: allProvinces.rows.map((r) => r.province),
    regions: places.rows
      .filter((r) => r.region_code)
      .map((r) => ({ code: r.region_code, name: r.region_name })),
  }));
}

/** Per-province register completeness, for the panel under the map. */
async function getRegisterCompleteness(ctx: Ctx): Promise<void> {
  const rows = await pool.query('SELECT * FROM v_register_completeness');
  const national = await pool.query(
    `SELECT count(*)::int                             AS wards,
            count(*) FILTER (WHERE NOT EXISTS (
              SELECT 1 FROM station s WHERE s.ward_id = w.ward_id))::int
                                                      AS wards_without_stations,
            (SELECT count(*)::int FROM station)       AS stations
       FROM ward w`);
  json(ctx.res, 200, await envelope({
    provinces: rows.rows,
    national: national.rows[0] ?? null,
  }));
}

async function getCampaign(ctx: Ctx): Promise<void> {
  const result = await pool.query('SELECT * FROM v_campaign_eo');
  json(ctx.res, 200, await envelope(result.rows[0] ?? null));
}

async function getFloat(ctx: Ctx): Promise<void> {
  requireRole(ctx, 'treasurer');
  const result = await pool.query(
    'SELECT * FROM v_float_balance ORDER BY week_ending DESC, zone');
  json(ctx.res, 200, await envelope(result.rows));
}

async function getDecisions(ctx: Ctx): Promise<void> {
  const limit = intParam(ctx.url, 'limit', 100, 1, 500);
  const q = ctx.url.searchParams.get('q');
  const result = await pool.query(
    `SELECT l.* FROM v_decision_log l
       JOIN decision d USING (decision_id)
      WHERE ($1::text IS NULL OR d.search @@ websearch_to_tsquery('english', $1))
      ORDER BY l.taken_on DESC, l.decision_id DESC
      LIMIT $2`,
    [q, limit],
  );
  json(ctx.res, 200, await envelope(result.rows));
}

/** Restricted documents need treasurer or admin. The register is the one
 *  place personal data accumulates, so the role gate is real here. */
async function getDocuments(ctx: Ctx): Promise<void> {
  const privileged = ctx.role === 'admin' || ctx.role === 'treasurer';
  const q = ctx.url.searchParams.get('q');
  const result = await pool.query(
    `SELECT r.* FROM v_document_register r
       JOIN document d USING (document_id)
      WHERE (r.sensitivity <> 'Restricted' OR $1)
        AND ($2::text IS NULL OR d.search @@ websearch_to_tsquery('english', $2))
      ORDER BY r.document_date DESC NULLS LAST`,
    [privileged, q],
  );
  json(ctx.res, 200, await envelope(result.rows));
}

/**
 * Everything the sentiment screen needs, in one round trip: the grid for
 * the heatmap, the bands for the diverging bar, the weekly series for the
 * small multiples, and a summary row.
 *
 * `synthetic` is returned explicitly. A sentiment figure whose provenance
 * the reader cannot see is decoration, and the screen says so on its face
 * rather than in a comment nobody reads.
 */
async function getSentiment(ctx: Ctx): Promise<void> {
  const municipality = ctx.url.searchParams.get('municipality');

  // Which feed is being read. Default is the first row of v_signal_sources,
  // which orders real feeds ahead of the synthetic one: once something real
  // is connected the screen stops opening on invented numbers by itself.
  const sources = await pool.query<{ source_id: string }>(
    'SELECT * FROM v_signal_sources');
  const asked = ctx.url.searchParams.get('source');
  const chosen = sources.rows.some((s) => s.source_id === asked)
    ? asked!
    : sources.rows[0]?.source_id ?? null;

  const [area, bands, trend, summary] = await Promise.all([
    pool.query(
      `SELECT * FROM v_sentiment_area
        WHERE source = $2 AND ($1::text IS NULL OR municipality = $1)
        ORDER BY municipality, category`, [municipality, chosen]),
    pool.query(
      `SELECT * FROM v_sentiment_bands
        WHERE source = $2 AND ($1::text IS NULL OR municipality = $1)
        ORDER BY municipality, band_order`, [municipality, chosen]),
    pool.query(
      `SELECT t.* FROM v_sentiment_trend t WHERE t.source = $1
        ORDER BY t.category, t.week_start`, [chosen]),
    pool.query(
      `SELECT count(*)::int                                   AS signals,
              count(DISTINCT ward_id)::int                    AS wards,
              count(DISTINCT COALESCE(ward_id, demarcation_code))::int AS places,
              count(DISTINCT category)::int                   AS categories,
              COALESCE(sum(mentions), 0)::int                 AS mentions,
              ROUND(AVG(net_sentiment), 3)                    AS net_sentiment,
              ROUND(AVG(confidence), 3)                       AS confidence,
              max(observed_on)                                AS last_observed,
              min(geo_level)::text                            AS geo_level,
              bool_and(source = 'SYNTHETIC')                  AS synthetic
         FROM issue_signal s
        CROSS JOIN control_panel cp
        WHERE s.source = $1
          AND s.observed_on >= CURRENT_DATE - cp.sentiment_window_days`, [chosen]),
  ]);

  json(ctx.res, 200, {
    as_of: new Date().toISOString(),
    data: {
      summary: summary.rows[0] ?? null,
      sources: sources.rows,
      chosen,
      area: area.rows,
      bands: bands.rows,
      trend: trend.rows,
    },
  });
}

async function getIngestHealth(ctx: Ctx): Promise<void> {
  const [register, ingest] = await Promise.all([
    // Ordered so the live feeds come first and the closed door comes last:
    // the screen should open on what is working, not on what never will.
    pool.query(
      `SELECT * FROM v_source_register
        ORDER BY array_position(
          ARRAY['Live','Failing','Never run','Not connected','Closed'], status), label`),
    pool.query('SELECT * FROM v_ingest_health ORDER BY source'),
  ]);
  json(ctx.res, 200, {
    as_of: await asOf(),
    data: { register: register.rows, ingest: ingest.rows },
  });
}

async function getSearch(ctx: Ctx): Promise<void> {
  const q = (ctx.url.searchParams.get('q') ?? '').trim();
  // Two characters matches most of the ledger and tells the user nothing.
  if (q.length < 2) {
    json(ctx.res, 200, { as_of: await asOf(), data: [] });
    return;
  }
  const limit = intParam(ctx.url, 'limit', 20, 1, 50);
  const result = await pool.query(
    'SELECT kind, id, title, subtitle, dated, rank FROM search_everything($1, $2)',
    [q, limit]);
  json(ctx.res, 200, await envelope(result.rows));
}

/** Cameras for the viewshed, within a bounding box.
 *
 *  Served from our own cache, never proxied live: Overpass asks that its
 *  public endpoint be left to human-operated tools, and a screen that
 *  re-queries it on every pan would be exactly what they are asking people
 *  not to build. */
async function getCameras(ctx: Ctx): Promise<void> {
  const num = (k: string, fallback: number) => {
    const raw = ctx.url.searchParams.get(k);
    const parsed = raw === null ? NaN : Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const south = num('south', 51.495), north = num('north', 51.525);
  const west = num('west', -0.145), east = num('east', -0.095);
  const limit = intParam(ctx.url, 'limit', 400, 1, 2000);

  const result = await pool.query(
    `SELECT camera_id, source_id, external_id, name, lat, lon,
            bearing_deg, bearing_basis, fov_deg, range_m, mount_height_m,
            camera_type, estimated
       FROM camera
      WHERE lat BETWEEN $1 AND $2 AND lon BETWEEN $3 AND $4
      ORDER BY bearing_deg IS NULL, camera_id
      LIMIT $5`,
    [south, north, west, east, limit]);

  json(ctx.res, 200, {
    as_of: await asOf(),
    data: result.rows,
    bbox: { south, north, west, east },
  });
}

async function getTerrain(ctx: Ctx): Promise<void> {
  const num = (k: string, fallback: number) => {
    const raw = ctx.url.searchParams.get(k);
    const parsed = raw === null ? NaN : Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const bbox = {
    south: num('south', 51.495), north: num('north', 51.525),
    west: num('west', -0.145), east: num('east', -0.095),
  };
  if (bbox.north <= bbox.south || bbox.east <= bbox.west) {
    throw new HttpError(400, 'north must exceed south and east must exceed west');
  }
  // Capped: the mesh is size^2 vertices and the grid is sent as JSON.
  const size = intParam(ctx.url, 'size', 128, 32, 192);
  json(ctx.res, 200, { as_of: await asOf(), data: await terrainGrid(bbox, size) });
}

async function getControlPanel(ctx: Ctx): Promise<void> {
  json(ctx.res, 200, {
    as_of: await asOf(),
    data: { fields: FIELDS, values: await readPanel() },
  });
}

async function putControlPanel(ctx: Ctx): Promise<void> {
  // These parameters move the headline number. Reading them is open to any
  // signed-in account; changing them is not.
  requireRole(ctx, 'admin');

  const patch = await readJson<Record<string, unknown>>(ctx.req);
  const { row, problems } = await writePanel(patch, ctx.userId ?? 'unknown');
  if (problems.length > 0) { json(ctx.res, 422, { problems }); return; }

  // The extract is computed from these numbers, so it is stale the moment
  // they change. Refreshed here rather than left for someone to remember.
  await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_campaign_extract');
  json(ctx.res, 200, { as_of: await asOf(), data: row });
}

/** Everything the overview needs, in one round trip.
 *
 *  Six queries rather than six fetches: the screen is the first thing seen
 *  after signing in and it should arrive whole rather than assembling itself
 *  panel by panel. */
async function getOverview(ctx: Ctx): Promise<void> {
  const [campaign, act, issues, sources, sentiment, municipal, scope] = await Promise.all([
    pool.query('SELECT * FROM v_campaign_eo'),
    // target_class and pressure_band are computed in v_ward_target, not
    // carried on the extract, so the two are joined rather than guessed at.
    pool.query(
      `SELECT t.ward_id, t.municipality, t.recommended_box, t.target_class,
              t.pressure_band, x.eo_est_votes, x.score_rank
         FROM v_ward_target t
         JOIN mv_campaign_extract x USING (ward_id)
        WHERE t.target_class = 'ACT NOW'
        ORDER BY x.score_rank NULLS LAST
        LIMIT 8`),
    pool.query(
      `SELECT category::text AS category, sum(mentions)::int AS mentions,
              round(avg(net_sentiment), 3)::float AS net
         FROM issue_signal
        WHERE observed_on > current_date - (
                SELECT sentiment_window_days FROM control_panel WHERE id)
        GROUP BY category ORDER BY mentions DESC`),
    pool.query(
      `SELECT source_id, label, status, last_ok_at, kind::text AS kind
         FROM v_source_register
        ORDER BY array_position(
          ARRAY['Failing','Live','Never run','Not connected','Closed'], status), label`),
    pool.query(
      `SELECT count(DISTINCT ward_id)::int AS wards,
              sum(mentions)::int AS mentions,
              bool_and(source = 'SYNTHETIC') AS synthetic
         FROM issue_signal`),
    pool.query(
      `SELECT m.name AS municipality, f.category::text AS category, f.value, f.financial_year
         FROM service_fact f JOIN municipality m USING (demarcation_code)
        WHERE f.metric LIKE 'service_charge_revenue.%'
          AND f.financial_year = (SELECT max(financial_year) FROM service_fact)
        ORDER BY f.value DESC`),
    /* Scope, and how much of it has an electoral baseline. The Overview used
       to say "wards in Gauteng" from a hardcoded string, which stopped being
       true the moment the register went national — and it had no way to tell
       a genuine zero from a ward it knows nothing about. */
    pool.query(
      `SELECT count(DISTINCT province)::int        AS provinces,
              count(*)::int                        AS wards,
              count(registered_voters)::int        AS wards_with_roll
         FROM ward`),
  ]);

  json(ctx.res, 200, {
    as_of: await asOf(),
    data: {
      campaign: campaign.rows[0] ?? null,
      act_now: act.rows,
      issues: issues.rows,
      sources: sources.rows,
      sentiment: sentiment.rows[0] ?? null,
      municipal: municipal.rows,
      register: scope.rows[0] ?? null,
    },
  });
}

export const routes = {
  postLogin, postLogout, getMe, getWards, getWard, getTargets,
  getCampaign, getFloat, getDecisions, getDocuments, getIngestHealth,
  getSentiment, getSearch, getCameras, getTerrain,
  getControlPanel, putControlPanel, getOverview, getTrending,
  getStationMap, getRegisterCompleteness, authenticate,
};
