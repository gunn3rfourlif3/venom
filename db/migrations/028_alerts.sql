-- Alerts.
--
-- THE DESIGN PROBLEM IS NOT DETECTION, IT IS RESTRAINT.
--
-- Every condition worth alerting on is trivial to detect - the views
-- already carry them. What is hard is not sending 19,803 notifications at
-- 07:05 because nobody has reported yet, which is GOTCHAS.md G4 and the
-- reason this table exists at all. An alerting system people mute is worse
-- than none, because they believe it is still working.
--
-- Three mechanisms keep it quiet:
--
--   1. dedupe_key is UNIQUE. An alert is raised once per condition, per
--      subject, per window - the insert simply fails the second time. Same
--      trick the WhatsApp webhook uses for redelivery, and it means the
--      engine can run every minute without thinking about it.
--   2. Silence is aggregated, never per station. "412 stations have not
--      reported" is one alert; 412 alerts is a muted phone.
--   3. A ceiling per run. If something goes badly wrong at scale, the
--      engine says so once rather than enumerating it.

CREATE TYPE alert_kind AS ENUM (
  'UNSTAFFED',           -- a station reported, and nobody is there
  'SUPPLY_BROKEN',       -- a ward's deployment failed
  'SERIOUS_PROBLEM',     -- a high-severity problem was reported
  'WIDESPREAD_SILENCE',  -- aggregate: stations that were reporting went quiet
  'INGEST_DOWN',         -- no messages arriving; the pipe, not the ground
  -- Raised instead of enumerating when more conditions are open than the
  -- per-run ceiling. Its own kind because "31 stations have a condition" is
  -- a different thing from any one of those stations' problems, and filing
  -- it under one of them misdescribes both.
  'MANY_CONDITIONS'
);

CREATE TABLE alert (
  alert_id    bigserial PRIMARY KEY,
  kind        alert_kind  NOT NULL,
  -- The thing the alert is about: a station id, or 'CAMPAIGN' for one that
  -- is about the whole operation rather than a place.
  scope       text        NOT NULL,
  /* kind + scope + time bucket. The UNIQUE index on it is the entire
     deduplication and rate-limiting mechanism - there is no timer, no
     in-memory state and nothing to get out of step after a restart. */
  dedupe_key  text        NOT NULL UNIQUE,
  raised_at   timestamptz NOT NULL DEFAULT now(),
  severity    text        NOT NULL CHECK (severity IN ('warn', 'serious')),
  body        text        NOT NULL,
  -- The figure that triggered it, so a reader can see how bad without
  -- parsing the sentence.
  value       integer,
  station_id  text        REFERENCES station (station_id),
  -- Delivery is recorded, not assumed. An alert that was raised and never
  -- sent is the failure mode worth being able to see.
  delivered_at   timestamptz,
  delivery_error text,
  acknowledged_at timestamptz,
  acknowledged_by text
);

CREATE INDEX idx_alert_recent ON alert (raised_at DESC);
CREATE INDEX idx_alert_undelivered ON alert (raised_at)
  WHERE delivered_at IS NULL AND delivery_error IS NULL;
CREATE INDEX idx_alert_open ON alert (kind, raised_at DESC)
  WHERE acknowledged_at IS NULL;

COMMENT ON TABLE alert IS
  'Raised alerts, deduplicated by dedupe_key. One row per condition per '
  'subject per window; delivery outcome recorded rather than assumed.';

-- Every threshold alongside the others, so none of this is hardcoded in a
-- query somebody has to go and find on the day.
ALTER TABLE control_panel
  -- How long a condition stays "the same alert". An hour means a station
  -- that is still unstaffed at 09:00 raises again, having first raised at
  -- 08:00 - which is right: it is still wrong and somebody should know.
  ADD COLUMN IF NOT EXISTS alert_window_minutes integer NOT NULL DEFAULT 60
    CHECK (alert_window_minutes BETWEEN 5 AND 1440),
  -- The ceiling. Past this the engine raises one aggregate alert instead of
  -- enumerating, because beyond a point a longer list stops adding anything.
  ADD COLUMN IF NOT EXISTS alert_max_per_run integer NOT NULL DEFAULT 25
    CHECK (alert_max_per_run BETWEEN 1 AND 500),
  -- What share of stations being silent is worth waking somebody for.
  -- Deliberately high: before the first reporting cycle it is 100% and that
  -- is normal, so this is paired with a floor on reports already seen.
  ADD COLUMN IF NOT EXISTS silence_alert_pct numeric(4,3) NOT NULL DEFAULT 0.400
    CHECK (silence_alert_pct > 0 AND silence_alert_pct <= 1);

/* What is currently wrong, as the engine sees it.
 *
 * Separate from the alert table on purpose: this is the live condition and
 * alert is the record of having said so. A station can be unstaffed without
 * a new alert, because one was already raised this window - and the board
 * should still show it as unstaffed. */
CREATE VIEW v_alert_conditions AS
SELECT 'UNSTAFFED'::alert_kind AS kind,
       b.station_id            AS scope,
       'serious'              AS severity,
       b.station_id, 1 AS value,
       format('%s (%s) reported but has nobody there',
              b.name, COALESCE(w.municipality, b.ward_id)) AS body
  FROM v_booth_logistics b
  LEFT JOIN ward w USING (ward_id)
 WHERE b.presence_flag = 'UNSTAFFED'

UNION ALL
SELECT 'SERIOUS_PROBLEM', b.station_id, 'serious', b.station_id, 1,
       format('%s (%s): %s', b.name, COALESCE(w.municipality, b.ward_id), b.problem)
  FROM v_booth_logistics b
  LEFT JOIN ward w USING (ward_id)
 WHERE b.severity = 'high' AND b.problem IS NOT NULL

UNION ALL
-- Supply is a ward-level fact, so the alert is raised per ward and not once
-- per station in it. Migration 025 renamed those columns for this reason.
SELECT 'SUPPLY_BROKEN', w.ward_id, 'serious', NULL, count(*)::int,
       format('Supply failed for ward %s (%s): %s stations affected',
              w.ward_id, w.municipality, count(*))
  FROM v_booth_logistics b
  JOIN ward w USING (ward_id)
 WHERE b.supply_flag = 'SUPPLY_BROKEN'
 GROUP BY w.ward_id, w.municipality;

COMMENT ON VIEW v_alert_conditions IS
  'Per-subject conditions that merit an alert. Aggregate conditions '
  '(widespread silence, ingest down) are computed in the engine, because '
  'they depend on thresholds and on whether reporting has started at all.';

/* Who hears about it.
 *
 * Separate from reporter_roster, which is marshals filing reports. These are
 * the few people who should be interrupted, and the distinction matters:
 * conflating "can file a report" with "should be woken at 03:00" is how an
 * alert list grows until nobody reads it.
 *
 * Same retention rule as every other contact detail we hold for our own
 * staff - see booth_report.retention_until. */
CREATE TABLE alert_recipient (
  phone           text PRIMARY KEY
    CONSTRAINT alert_phone_is_e164 CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  display_name    text NOT NULL,
  -- 'serious' hears only the serious ones; 'all' hears everything.
  wants           text NOT NULL DEFAULT 'serious'
    CHECK (wants IN ('serious', 'all')),
  enabled         boolean NOT NULL DEFAULT true,
  added_by        text NOT NULL,
  added_at        timestamptz NOT NULL DEFAULT now(),
  retention_until date NOT NULL DEFAULT (CURRENT_DATE + 180)
);

CREATE INDEX idx_alert_recipient_enabled ON alert_recipient (enabled) WHERE enabled;

COMMENT ON TABLE alert_recipient IS
  'The short list of people an alert interrupts. Deliberately not the '
  'marshal roster: filing a report and needing to be woken are different '
  'jobs.';
