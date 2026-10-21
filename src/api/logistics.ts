import { pool } from '../db.js';
import { HttpError, json, readJson, intParam, enumParam, type Ctx } from './http.js';
import { requireRole } from './auth.js';

/* The logistics layer's read and write ends.
 *
 * ON THE SHAPE OF THE WRITE. The addendum asks for "one form, 4 fields, one
 * person". What actually lands in front of that person is fifty WhatsApp
 * lines in one message, every two hours, in the template:
 *
 *     10234 med none 3
 *     10235 long IEC official late 2
 *
 * A four-field form means fifty page loads and fifty chances to mistype a
 * booth number at 07:00. So the form takes the paste whole, parses it, and
 * shows what each line resolved to BEFORE anything is written. Four fields
 * for one report is still there underneath - a single line is a valid
 * paste - but the batch is the real job.
 *
 * Nothing is written until the operator has seen the parse, because the
 * table is append-only: a bad row cannot be edited away afterwards.
 */

const QUEUE: Record<string, string> = {
  short: 'short', s: 'short',
  med: 'medium', medium: 'medium', m: 'medium',
  long: 'long', l: 'long',
  none: 'none', no: 'none', empty: 'none',
};

export interface ParsedLine {
  line: number;
  raw: string;
  stationId: string | null;
  queue: string | null;
  problem: string | null;
  peopleOnSite: number | null;
  error: string | null;
}

/** One WhatsApp line. Deliberately forgiving about spacing and case and
 *  strict about the booth number, because that is the field a wrong value
 *  silently misfiles rather than visibly breaks. */
export function parseLine(raw: string, line: number): ParsedLine {
  const out: ParsedLine = {
    line, raw, stationId: null, queue: null, problem: null,
    peopleOnSite: null, error: null,
  };

  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) { out.error = 'empty line'; return out; }

  const [booth, ...rest] = tokens;
  if (!/^[A-Za-z0-9-]{1,32}$/.test(booth ?? '')) {
    out.error = `"${booth}" is not a booth number`;
    return out;
  }
  out.stationId = booth!;

  if (rest.length === 0) {
    out.error = 'nothing after the booth number';
    return out;
  }

  const queueWord = (rest[0] ?? '').toLowerCase();
  const queue = QUEUE[queueWord];
  if (!queue) {
    out.error = `"${rest[0]}" is not a queue length (short, med, long, none)`;
    return out;
  }
  out.queue = queue;

  // The trailing head count, if the marshal sent one. Taken from the end so
  // that a problem description containing a number - "IEC official late 2" -
  // keeps its words and gives up only the last token.
  const tail = rest.slice(1);
  const last = tail[tail.length - 1];
  if (last !== undefined && /^\d{1,4}$/.test(last)) {
    out.peopleOnSite = Number(last);
    tail.pop();
  }

  const problem = tail.join(' ').trim();
  const says = problem.toLowerCase();
  out.problem = problem === '' || says === 'none' || says === 'no' || says === '-'
    ? null
    : problem;

  if (out.peopleOnSite === null && out.problem === null) {
    out.error = 'no head count and no problem - nothing reported';
  }
  return out;
}

export function parseBatch(text: string): ParsedLine[] {
  return text.split(/\r?\n/)
    .map((raw, i) => [raw, i + 1] as const)
    .filter(([raw]) => raw.trim() !== '')
    .map(([raw, i]) => parseLine(raw, i));
}

/** A problem with no stated severity. The marshal's template has no severity
 *  field, so one is inferred from the words and the inference is shown to the
 *  operator, who can override it per line before committing. Anything not
 *  recognised is 'medium': not 'low', because an unrecognised complaint is
 *  not evidence of a small one. */
const SERIOUS = ['violence', 'fight', 'police', 'gun', 'threat', 'intimidat',
  'assault', 'stabb', 'shoot', 'riot', 'blocked', 'closed', 'no ballot',
  'power out', 'no power', 'flood',
  // Anything involving the IEC at a booth bears on whether that booth can
  // operate at all, so it outranks the word that usually accompanies it.
  // "IEC official late" is not a minor delay; it is a station that cannot
  // open. SERIOUS is tested first, so this wins over 'late' below.
  'iec', 'presiding officer', 'no ink', 'no scanner', 'no ballots'];
const MINOR = ['late', 'slow', 'queue', 'parking', 'tent', 'chair', 'table',
  'water bottle', 'signage', 'poster'];

export function inferSeverity(problem: string): 'low' | 'medium' | 'high' {
  const low = problem.toLowerCase();
  if (SERIOUS.some((w) => low.includes(w))) return 'high';
  if (MINOR.some((w) => low.includes(w))) return 'low';
  return 'medium';
}

// ------------------------------------------------------------------- reads

export async function getLogistics(ctx: Ctx): Promise<void> {
  const municipality = ctx.url.searchParams.get('municipality');
  const presence = enumParam(ctx.url, 'presence',
    ['NO_REPORT', 'STALE', 'UNSTAFFED', 'NO_PLAN', 'UNDERSTAFFED', 'STAFFED']);
  const limit = intParam(ctx.url, 'limit', 400, 1, 2000);

  /* The default view wants only stations where something has happened, and
     it used to get 400 rows of whatever sorted first and discard most of
     them in the browser. Filtering here instead cut the payload from 172 KB
     to a few, and the sort now runs over the handful of rows that qualify
     rather than over all 19,803.
     'NO_REPORT' is excluded because silence is summarised separately - see
     the rollup below and GOTCHAS.md G4. */
  const exceptionsOnly = ctx.url.searchParams.get('mode') === 'exceptions';
  const where = `($1::text IS NULL OR w.municipality = $1)
          AND ($2::text IS NULL OR b.presence_flag = $2)
          AND (NOT $3::boolean OR (
                b.presence_flag NOT IN ('STAFFED', 'NO_REPORT')
                OR b.supply_flag = 'SUPPLY_BROKEN'
                OR b.severity = 'high'))`;

  const [rollup, stations, matching, recent, panel, rate, provinces, silence] = await Promise.all([
    pool.query('SELECT * FROM v_logistics_rollup'),
    pool.query(
      `SELECT b.*, w.municipality
         FROM v_booth_logistics b
         LEFT JOIN ward w USING (ward_id)
        WHERE ${where}
        ORDER BY array_position(
                   ARRAY['UNSTAFFED','SUPPLY_BROKEN','NO_REPORT','STALE',
                         'UNDERSTAFFED','NO_PLAN','STAFFED'], b.presence_flag),
                 b.severity = 'high' DESC,
                 b.station_id
        LIMIT $4`,
      [municipality, presence, exceptionsOnly, limit]),
    // How many match the filter in total, as distinct from how many were
    // returned. Without it the screen can only say "400 of 400 stations",
    // which on a register of 23,699 reads as "that is all of them" when it
    // means "that is all we sent you".
    pool.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM v_booth_logistics b
         LEFT JOIN ward w USING (ward_id)
        WHERE ${where}`,
      [municipality, presence, exceptionsOnly]),
    // The last hour of filings, so the operator can see their own typing
    // land and spot a line they sent twice.
    pool.query(
      `SELECT booth_report_id, station_id, reported_at, reported_by,
              queue, problem, problem_severity, people_on_site
         FROM booth_report
        WHERE reported_at > now() - interval '2 hours'
        ORDER BY reported_at DESC
        LIMIT 60`),
    pool.query(
      `SELECT report_stale_minutes, understaffed_ratio, ingest_silence_minutes
         FROM control_panel`),
    // Ingest health travels with the board rather than on its own endpoint.
    // A webhook that stops being called looks exactly like a quiet day, so
    // the screen that shows the quiet has to show the ingest beside it.
    pool.query('SELECT * FROM v_ingest_rate'),

    /* Silence, rolled up by municipality.
     *
     * Before the first reporting cycle every station in the country is
     * NO_REPORT, so the exceptions table lists ~19,800 identical rows and
     * tells the operator nothing. That is GOTCHAS.md G4 in table form: an
     * exception that applies to everything is not an exception.
     *
     * Grouped, it becomes usable. "Dr Beyers Naude: 54 of 54 silent" is a
     * sentence somebody can act on; fifty-four rows reading NO REPORT are
     * fifty-four rows somebody scrolls past. */
    // Which provinces the register actually covers, for the rail's scope
    // line. It used to read "Gauteng" because that word was in the markup.
    pool.query<{ province: string }>(
      `SELECT DISTINCT province FROM ward
        WHERE province IS NOT NULL AND province <> '' ORDER BY province`),

    pool.query(
      `SELECT w.municipality,
              count(*)::int AS stations,
              count(*) FILTER (WHERE b.presence_flag = 'NO_REPORT')::int AS silent
         FROM v_booth_logistics b
         JOIN ward w USING (ward_id)
        WHERE ($1::text IS NULL OR w.municipality = $1)
        GROUP BY w.municipality
       HAVING count(*) FILTER (WHERE b.presence_flag = 'NO_REPORT') > 0
        ORDER BY 3 DESC, 1
        LIMIT 80`, [municipality]),
  ]);

  json(ctx.res, 200, {
    as_of: new Date().toISOString(),
    data: {
      rollup: rollup.rows[0] ?? null,
      stations: stations.rows,
      matching: matching.rows[0]?.n ?? stations.rows.length,
      limit,
      recent: recent.rows,
      thresholds: panel.rows[0] ?? null,
      rate: rate.rows[0] ?? null,
      silence: silence.rows,
      provinces: provinces.rows.map((p) => p.province),
    },
  });
}

/** The call sheet: marshal contact details for the stations that are dark.
 *
 *  Separated from the dashboard read on purpose. This is the one endpoint
 *  that serves a phone number, it needs a role, and keeping it apart means
 *  the number is not sitting in the payload of a screen left open on a
 *  desk all day. */
export async function getCallSheet(ctx: Ctx): Promise<void> {
  requireRole(ctx, 'reporter');
  const result = await pool.query(
    `SELECT b.station_id, b.name, b.ward_id, b.presence_flag,
            b.minutes_since_report, s.marshal_name, s.marshal_phone
       FROM v_booth_logistics b
       JOIN station s USING (station_id)
      WHERE b.presence_flag IN ('NO_REPORT','STALE','UNSTAFFED')
        AND s.marshal_phone IS NOT NULL
      ORDER BY array_position(
        ARRAY['UNSTAFFED','NO_REPORT','STALE'], b.presence_flag),
        b.minutes_since_report DESC NULLS LAST`);
  json(ctx.res, 200, { as_of: new Date().toISOString(), data: result.rows });
}

export async function getStationReports(ctx: Ctx, stationId: string): Promise<void> {
  if (!/^[A-Za-z0-9-]{1,32}$/.test(stationId)) throw new HttpError(400, 'Bad station id');
  const result = await pool.query(
    `SELECT booth_report_id, reported_at, reported_by, queue, weather,
            problem, problem_severity, people_on_site, notes
       FROM booth_report WHERE station_id = $1
      ORDER BY reported_at DESC LIMIT 100`, [stationId]);
  json(ctx.res, 200, { as_of: new Date().toISOString(), data: result.rows });
}

// ------------------------------------------------------------------ writes

/** Parse a paste and say what it means, writing nothing.
 *
 *  Unknown booth numbers are named back rather than left for the foreign key
 *  to reject at commit: at 07:00 "10324 is not a booth" is a useful sentence
 *  and "insert or update on table violates foreign key constraint" is not. */
export async function postParse(ctx: Ctx): Promise<void> {
  requireRole(ctx, 'reporter');
  const body = await readJson<{ text?: string }>(ctx.req);
  if (typeof body.text !== 'string') throw new HttpError(400, 'text required');

  const parsed = parseBatch(body.text);
  if (parsed.length === 0) { json(ctx.res, 200, { data: { lines: [], known: [] } }); return; }

  const ids = [...new Set(parsed.map((p) => p.stationId).filter((s): s is string => !!s))];
  const { rows } = await pool.query<{ station_id: string; name: string; ward_id: string }>(
    'SELECT station_id, name, ward_id FROM station WHERE station_id = ANY($1)', [ids]);
  const known = new Map(rows.map((r) => [r.station_id, r]));

  const lines = parsed.map((p) => {
    const station = p.stationId ? known.get(p.stationId) : undefined;
    return {
      ...p,
      stationName: station?.name ?? null,
      wardId: station?.ward_id ?? null,
      severity: p.problem ? inferSeverity(p.problem) : null,
      error: p.error ?? (p.stationId && !station
        ? `booth ${p.stationId} is not in the register`
        : null),
    };
  });

  json(ctx.res, 200, {
    data: {
      lines,
      ok: lines.filter((l) => l.error === null).length,
      bad: lines.filter((l) => l.error !== null).length,
    },
  });
}

/** Commit reports. Takes the parsed rows back from the client so that what
 *  is written is what the operator saw and corrected, not a re-parse that
 *  might differ. Every row is re-validated here regardless. */
export async function postReports(ctx: Ctx): Promise<void> {
  requireRole(ctx, 'reporter');
  const body = await readJson<{
    reportedBy?: string;
    reporterPhone?: string;
    weather?: string;
    reports?: Array<{
      stationId?: string; queue?: string; problem?: string | null;
      severity?: string | null; peopleOnSite?: number | null; notes?: string;
    }>;
  }>(ctx.req);

  const reportedBy = (body.reportedBy ?? '').trim();
  if (reportedBy === '') throw new HttpError(400, 'reportedBy required');
  if (reportedBy.length > 120) throw new HttpError(400, 'reportedBy too long');

  const reports = body.reports ?? [];
  if (reports.length === 0) throw new HttpError(400, 'no reports');
  if (reports.length > 500) throw new HttpError(413, 'too many reports in one batch');

  const weather = body.weather && ['clear', 'rain', 'heavy rain'].includes(body.weather)
    ? body.weather : null;

  const client = await pool.connect();
  const written: number[] = [];
  const refused: Array<{ stationId: string; reason: string }> = [];
  try {
    await client.query('BEGIN');
    for (const r of reports) {
      const stationId = (r.stationId ?? '').trim();
      if (!/^[A-Za-z0-9-]{1,32}$/.test(stationId)) {
        refused.push({ stationId, reason: 'bad booth number' });
        continue;
      }
      const queue = r.queue && ['short', 'medium', 'long', 'none'].includes(r.queue)
        ? r.queue : null;
      const problem = r.problem?.trim() || null;
      const severity = problem
        ? (r.severity && ['low', 'medium', 'high'].includes(r.severity)
            ? r.severity : inferSeverity(problem))
        : null;
      const people = typeof r.peopleOnSite === 'number'
        && Number.isInteger(r.peopleOnSite) && r.peopleOnSite >= 0 && r.peopleOnSite < 10000
        ? r.peopleOnSite : null;

      // A savepoint per row. One unknown booth number must not lose the
      // other forty-nine: in Postgres any error aborts the whole
      // transaction unless there is a savepoint to come back to.
      await client.query('SAVEPOINT row');
      try {
        const { rows } = await client.query<{ booth_report_id: number }>(
          `INSERT INTO booth_report
             (station_id, reported_by, reporter_phone, queue, weather,
              problem, problem_severity, people_on_site, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           RETURNING booth_report_id`,
          [stationId, reportedBy, body.reporterPhone?.trim() || null, queue,
            weather, problem, severity, people, r.notes?.trim() || null]);
        await client.query('RELEASE SAVEPOINT row');
        if (rows[0]) written.push(rows[0].booth_report_id);
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT row');
        const code = (error as { code?: string }).code;
        if (code === '23503') {
          refused.push({ stationId, reason: 'not in the station register' });
        } else if (code === '23514') {
          refused.push({ stationId, reason: 'a value failed a check constraint' });
        } else throw error;
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  json(ctx.res, 201, { data: { written: written.length, refused } });
}

/** Deployment arrival. The supply line's other end: a dispatcher marking
 *  that the stock reached the ward, or did not. */
export async function patchDeployment(ctx: Ctx, id: string): Promise<void> {
  requireRole(ctx, 'reporter');
  const deploymentId = Number(id);
  if (!Number.isInteger(deploymentId)) throw new HttpError(400, 'Bad deployment id');

  const body = await readJson<{ status?: string; note?: string }>(ctx.req);
  const status = body.status ?? '';
  if (!['pending', 'arrived', 'partial', 'failed'].includes(status)) {
    throw new HttpError(400, 'status must be pending, arrived, partial or failed');
  }
  if ((status === 'partial' || status === 'failed') && !body.note?.trim()) {
    // A failed drop with no reason is a figure nobody can act on.
    throw new HttpError(400, 'partial and failed need a note saying what was short');
  }

  const { rows } = await pool.query(
    `UPDATE deployment
        SET arrival_status = $2,
            arrived_at = CASE WHEN $2 IN ('arrived','partial') THEN now() ELSE arrived_at END,
            shortfall_note = $3
      WHERE deployment_id = $1
      RETURNING deployment_id, ward_id, arrival_status, arrived_at, shortfall_note`,
    [deploymentId, status, body.note?.trim() || null]);
  if (!rows[0]) throw new HttpError(404, 'No such deployment');
  json(ctx.res, 200, { data: rows[0] });
}

export const logistics = {
  getLogistics, getCallSheet, getStationReports,
  postParse, postReports, patchDeployment,
  getAlerts, postAlertAck,
};

/** Open alerts for the board.
 *
 *  Unacknowledged first and newest first: the board's job is to show what
 *  nobody has picked up yet. Acknowledged alerts stay in the table as the
 *  record that somebody saw it and when. */
export async function getAlerts(ctx: Ctx): Promise<void> {
  const limit = intParam(ctx.url, 'limit', 50, 1, 200);
  const [open, counts] = await Promise.all([
    pool.query(
      `SELECT alert_id, kind::text AS kind, scope, severity, body, value,
              station_id, raised_at, delivered_at, delivery_error,
              acknowledged_at, acknowledged_by
         FROM alert
        WHERE acknowledged_at IS NULL
        ORDER BY severity = 'serious' DESC, raised_at DESC
        LIMIT $1`, [limit]),
    pool.query(
      `SELECT count(*) FILTER (WHERE acknowledged_at IS NULL)::int AS open,
              count(*) FILTER (WHERE acknowledged_at IS NULL
                               AND severity = 'serious')::int      AS open_serious,
              count(*) FILTER (WHERE delivered_at IS NULL
                               AND delivery_error IS NOT NULL)::int AS undelivered
         FROM alert WHERE raised_at > now() - interval '24 hours'`),
  ]);
  json(ctx.res, 200, {
    as_of: new Date().toISOString(),
    data: { alerts: open.rows, counts: counts.rows[0] ?? null },
  });
}

/** Acknowledging is a claim that a person has it in hand, so it records who
 *  and when rather than simply clearing the row. */
export async function postAlertAck(ctx: Ctx, id: string): Promise<void> {
  requireRole(ctx, 'reporter');
  const alertId = Number(id);
  if (!Number.isInteger(alertId)) throw new HttpError(400, 'Bad alert id');
  const { rows } = await pool.query(
    `UPDATE alert
        SET acknowledged_at = now(), acknowledged_by = $2
      WHERE alert_id = $1 AND acknowledged_at IS NULL
      RETURNING alert_id, acknowledged_at, acknowledged_by`,
    [alertId, ctx.userId ?? 'unknown']);
  if (!rows[0]) throw new HttpError(404, 'No such open alert');
  json(ctx.res, 200, { data: rows[0] });
}
