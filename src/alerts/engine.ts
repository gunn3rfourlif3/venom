import type { PoolClient } from 'pg';
import { pool } from '../db.js';

/* The alert engine.
 *
 * Runs on a timer, looks at what is currently wrong, and raises an alert for
 * anything not already raised in this window.
 *
 * THE WHOLE DESIGN IS THE DEDUPE KEY. `kind:scope:bucket` is UNIQUE, so the
 * second attempt to raise the same condition for the same subject in the
 * same window simply does not insert, and RETURNING tells us what was
 * genuinely new. There is no timer state, no in-memory set of "already
 * sent", and nothing that goes wrong after a restart - which matters on a
 * day when the process may be restarted and nobody wants 19,803 duplicate
 * notifications as a result.
 */

export interface Alert {
  alert_id: number;
  kind: string;
  scope: string;
  severity: 'warn' | 'serious';
  body: string;
  value: number | null;
  station_id: string | null;
}

interface Panel {
  alert_window_minutes: number;
  alert_max_per_run: number;
  silence_alert_pct: string;
  ingest_silence_minutes: number;
}

/** The window this moment falls in. Alerts raised in the same bucket for the
 *  same subject collapse into one. */
export function bucketFor(now: Date, windowMinutes: number): string {
  const ms = windowMinutes * 60_000;
  return new Date(Math.floor(now.getTime() / ms) * ms).toISOString();
}

export async function evaluate(client: PoolClient): Promise<Alert[]> {
  const { rows: panelRows } = await client.query<Panel>(
    `SELECT alert_window_minutes, alert_max_per_run,
            silence_alert_pct, ingest_silence_minutes
       FROM control_panel`);
  const panel = panelRows[0];
  if (!panel) throw new Error('control_panel is empty');

  const bucket = bucketFor(new Date(), panel.alert_window_minutes);
  const raised: Alert[] = [];

  /* ---- per-subject conditions -------------------------------------- */

  const { rows: conditions } = await client.query<{
    kind: string; scope: string; severity: 'warn' | 'serious';
    body: string; value: number; station_id: string | null;
  }>(`SELECT kind::text, scope, severity, body, value, station_id
        FROM v_alert_conditions
       ORDER BY severity DESC, scope
       LIMIT $1`, [panel.alert_max_per_run + 1]);

  /* Past the ceiling, say so once instead of enumerating. A list of two
     hundred is not more actionable than a list of twenty-five; it is just
     longer, and the twenty-sixth entry is where people stop reading. */
  const overflowed = conditions.length > panel.alert_max_per_run;
  const toRaise = overflowed
    ? conditions.slice(0, panel.alert_max_per_run) : conditions;

  for (const c of toRaise) {
    const alert = await raise(client, {
      kind: c.kind, scope: c.scope, severity: c.severity,
      body: c.body, value: c.value, stationId: c.station_id, bucket,
    });
    if (alert) raised.push(alert);
  }

  if (overflowed) {
    const { rows: n } = await client.query<{ total: number }>(
      'SELECT count(*)::int AS total FROM v_alert_conditions');
    const total = n[0]?.total ?? conditions.length;
    const alert = await raise(client, {
      kind: 'MANY_CONDITIONS', scope: 'CAMPAIGN', severity: 'serious',
      body: `${total} stations have an open condition — more than the `
        + `${panel.alert_max_per_run} this alert will list. Open the board.`,
      value: total, stationId: null, bucket: `${bucket}:overflow`,
    });
    if (alert) raised.push(alert);
  }

  /* ---- widespread silence ------------------------------------------- */
  /*
   * The condition that needed the most care. Before the first reporting
   * cycle every station in the country is silent, so a naive rule fires on
   * all 23,699 at 07:05 - G4, the alert storm that trains people to ignore
   * alerts by 07:10.
   *
   * Two guards. It is ONE alert about the campaign, never one per station.
   * And it only applies once reporting has actually started: if nothing has
   * ever been filed, silence is the expected state and not news.
   */
  /*
   * The measure is STALE, not NO_REPORT, and the difference is the whole
   * point. A station that has never reported has not started; a station
   * that reported at 09:00 and nothing since has gone quiet. Only the
   * second is news.
   *
   * The first version of this counted both, and fired at 100% the moment a
   * single marshal filed the day's first report - announcing that 24,829
   * stations had "not been heard from" when the truth was that reporting
   * had barely begun. That is G4 wearing a different hat, and it is exactly
   * the alert that gets notifications switched off at 07:10.
   *
   * Measured against stations that have reported at least once, so the
   * denominator is the operation that actually exists rather than the one
   * on paper.
   */
  const { rows: silenceRows } = await client.query<{
    started: number; gone_quiet: number;
  }>(`SELECT count(*)::int AS started,
             count(*) FILTER (WHERE presence_flag = 'STALE')::int AS gone_quiet
        FROM v_booth_logistics
       WHERE presence_flag <> 'NO_REPORT'`);
  const s = silenceRows[0];
  // A handful of reporting stations is too small a base to call a trend on.
  if (s && s.started >= 20) {
    const share = s.gone_quiet / s.started;
    if (share >= Number(panel.silence_alert_pct)) {
      const alert = await raise(client, {
        kind: 'WIDESPREAD_SILENCE', scope: 'CAMPAIGN', severity: 'warn',
        body: `${s.gone_quiet} of ${s.started} reporting stations have gone `
          + `quiet (${Math.round(share * 100)}%). Stations that have not `
          + `started are not counted here.`,
        value: s.gone_quiet, stationId: null, bucket,
      });
      if (alert) raised.push(alert);
    }
  }

  /* ---- the pipe itself ----------------------------------------------- */
  /*
   * A webhook that stops being called looks exactly like a quiet day. This
   * is the alert that tells the two apart, and it is the one most likely to
   * matter: a silent ground operation is bad news, but a broken ingest is
   * bad news nobody can see.
   */
  const { rows: ingestRows } = await client.query<{ quiet_minutes: number | null }>(
    `SELECT EXTRACT(EPOCH FROM (now() - max(received_at))) / 60 AS quiet_minutes
       FROM inbound_message`);
  const quiet = ingestRows[0]?.quiet_minutes;
  if (quiet != null && quiet > panel.ingest_silence_minutes) {
    const alert = await raise(client, {
      kind: 'INGEST_DOWN', scope: 'CAMPAIGN', severity: 'serious',
      body: `No report has arrived for ${Math.round(quiet)} minutes. `
        + `Reports may be being sent and not landing.`,
      value: Math.round(quiet), stationId: null, bucket,
    });
    if (alert) raised.push(alert);
  }

  return raised;
}

async function raise(client: PoolClient, a: {
  kind: string; scope: string; severity: 'warn' | 'serious';
  body: string; value: number | null; stationId: string | null; bucket: string;
}): Promise<Alert | null> {
  const dedupe = `${a.kind}:${a.scope}:${a.bucket}`;
  const { rows } = await client.query<Alert>(
    `INSERT INTO alert (kind, scope, dedupe_key, severity, body, value, station_id)
     VALUES ($1::alert_kind, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING alert_id, kind::text, scope, severity, body, value, station_id`,
    [a.kind, a.scope, dedupe, a.severity, a.body, a.value, a.stationId]);
  return rows[0] ?? null;
}

/** Mark what was sent, and what failed trying. Delivery is recorded rather
 *  than assumed: an alert raised and never delivered is the failure worth
 *  being able to see afterwards. */
export async function markDelivered(
  client: PoolClient, ids: number[], error?: string,
): Promise<void> {
  if (ids.length === 0) return;
  await client.query(
    error
      ? `UPDATE alert SET delivery_error = $2 WHERE alert_id = ANY($1)`
      : `UPDATE alert SET delivered_at = now() WHERE alert_id = ANY($1)`,
    error ? [ids, error] : [ids]);
}

export async function recipients(
  client: PoolClient, severity: 'warn' | 'serious',
): Promise<Array<{ phone: string; display_name: string }>> {
  const { rows } = await client.query<{ phone: string; display_name: string }>(
    `SELECT phone, display_name FROM alert_recipient
      WHERE enabled AND ($1 = 'serious' OR wants = 'all')`, [severity]);
  return rows;
}

/** One run: evaluate, then hand what is new to the caller to deliver. */
export async function runOnce(): Promise<Alert[]> {
  const client = await pool.connect();
  try {
    return await evaluate(client);
  } finally {
    client.release();
  }
}
