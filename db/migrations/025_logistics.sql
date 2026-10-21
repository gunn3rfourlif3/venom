-- Logistics visibility: did our own intervention reach the ground.
--
-- Built from the developer addendum, with four changes where the spec would
-- not have worked against this schema. Each is marked CHANGED below.
--
-- The line this layer does NOT cross is worth restating, because it is the
-- opposite of the one everywhere else in Venom. Elsewhere the rule is that
-- no personal data about the public is stored. Here we deliberately store a
-- marshal's name and phone - but they are OUR people, doing a job, who gave
-- the number so HQ can ring them. That is operational contact data about
-- staff, not surveillance of the public, and the distinction holds only as
-- long as it is written down and the data has an expiry. Both below.

-- CHANGED 1. The spec declares station_id integer. station.station_id is
-- text in this schema (IEC voting station identifiers are codes, not
-- counters), so the foreign key would have failed at creation.
CREATE TABLE booth_report (
  booth_report_id  bigserial PRIMARY KEY,
  station_id       text NOT NULL REFERENCES station (station_id),
  reported_at      timestamptz NOT NULL DEFAULT now(),

  -- CHANGED 2. The spec has one free-text `reported_by` holding "marshal
  -- name + phone". Split, because a phone number is the part that needs a
  -- retention rule and you cannot expire half a text field. The phone is
  -- optional: a report is still useful from someone who did not leave one.
  reported_by      text NOT NULL,
  reporter_phone   text,

  queue            text CHECK (queue IN ('short','medium','long','none')),
  weather          text CHECK (weather IN ('clear','rain','heavy rain')),
  problem          text,
  problem_severity text CHECK (problem_severity IN ('low','medium','high')),
  people_on_site   integer CHECK (people_on_site >= 0),
  notes            text,

  -- POPIA. A contact number for a shift marshal has no business outliving
  -- the campaign. Defaulted rather than left to a later decision.
  retention_until  date NOT NULL DEFAULT (CURRENT_DATE + 180),

  CONSTRAINT problem_has_severity CHECK (
    (problem IS NULL) = (problem_severity IS NULL))
);

CREATE INDEX idx_booth_report_station_time
  ON booth_report (station_id, reported_at DESC);
CREATE INDEX idx_booth_report_retention ON booth_report (retention_until);

COMMENT ON TABLE booth_report IS
  'Append-only field reports from our own marshals. Holds staff contact '
  'details by design, with a retention date; holds nothing about voters.';

-- CHANGED 3. The spec says "Never update, never delete. This is the audit
-- trail" and then does nothing to make that true. A comment is not a
-- constraint. If this is the audit trail, a correction must be a new row
-- saying the earlier one was wrong, not an edit that erases it.
-- The one sanctioned change is retention clearing an expired phone number,
-- and it is permitted here rather than by disabling this trigger from a
-- script: a guard with an off switch is a guard with a window in it. The
-- row is copied, the phone nulled, and the result compared whole - so the
-- exception covers that one column on an expired row and cannot be widened
-- by accident into "retention may edit reports".
CREATE OR REPLACE FUNCTION booth_report_is_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  expected booth_report;
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.retention_until <= CURRENT_DATE
     AND NEW.reporter_phone IS NULL
     AND OLD.reporter_phone IS NOT NULL
  THEN
    expected := OLD;
    expected.reporter_phone := NULL;
    IF expected IS NOT DISTINCT FROM NEW THEN
      RETURN NEW;   -- retention, and nothing else, is allowed through
    END IF;
  END IF;

  RAISE EXCEPTION
    'booth_report is append-only: file a new report rather than changing one. '
    '(attempted % on report %)', TG_OP, OLD.booth_report_id;
END $$;

CREATE TRIGGER booth_report_no_update
  BEFORE UPDATE ON booth_report
  FOR EACH ROW EXECUTE FUNCTION booth_report_is_append_only();

-- Deletion is allowed only for retention expiry, which runs as a dedicated
-- statement-level job; a row-level delete by hand still raises.
CREATE TRIGGER booth_report_no_delete
  BEFORE DELETE ON booth_report
  FOR EACH ROW WHEN (OLD.retention_until > CURRENT_DATE)
  EXECUTE FUNCTION booth_report_is_append_only();

-- The fields the logistics layer needs on a station.
ALTER TABLE station
  ADD COLUMN IF NOT EXISTS opening_time    time,
  ADD COLUMN IF NOT EXISTS closing_time    time,
  ADD COLUMN IF NOT EXISTS marshal_name    text,
  ADD COLUMN IF NOT EXISTS marshal_phone   text,
  ADD COLUMN IF NOT EXISTS expected_people integer CHECK (expected_people >= 0),
  ADD COLUMN IF NOT EXISTS transport_route text;

COMMENT ON COLUMN station.reported_by IS
  'Superseded by booth_report. Kept for rows written before the logistics '
  'layer existed; new reports go to booth_report, which is append-only.';

ALTER TABLE deployment
  ADD COLUMN IF NOT EXISTS dispatched_at  timestamptz,
  ADD COLUMN IF NOT EXISTS arrived_at     timestamptz,
  ADD COLUMN IF NOT EXISTS arrival_status text
    CHECK (arrival_status IN ('pending','arrived','partial','failed')),
  ADD COLUMN IF NOT EXISTS shortfall_note text;

-- A report older than this is not a reading, it is a memory. Threshold lives
-- with every other model parameter rather than hardcoded in a view, so it is
-- changeable on the control panel on the day when three hours turns out to
-- be the wrong number.
ALTER TABLE control_panel
  ADD COLUMN IF NOT EXISTS report_stale_minutes integer NOT NULL DEFAULT 180
    CHECK (report_stale_minutes BETWEEN 15 AND 1440),
  ADD COLUMN IF NOT EXISTS understaffed_ratio numeric(4,3) NOT NULL DEFAULT 0.500
    CHECK (understaffed_ratio > 0 AND understaffed_ratio <= 1);

-- ------------------------------------------------------------------ views

CREATE VIEW v_booth_status_live AS
SELECT DISTINCT ON (station_id)
  station_id,
  reported_at,
  EXTRACT(EPOCH FROM (now() - reported_at)) / 60   AS minutes_since_report,
  queue,
  weather,
  problem,
  problem_severity,
  people_on_site,
  reported_by
FROM booth_report
ORDER BY station_id, reported_at DESC;

COMMENT ON VIEW v_booth_status_live IS
  'The latest report per station. reporter_phone is deliberately not '
  'exposed here: the dashboard never needs it, only the call sheet does.';

CREATE VIEW v_booth_logistics AS
WITH deploy AS (
  SELECT d.ward_id,
         COUNT(*) FILTER (WHERE d.arrival_status = 'arrived') AS arrived,
         COUNT(*) FILTER (WHERE d.arrival_status = 'partial') AS partial,
         COUNT(*) FILTER (WHERE d.arrival_status = 'failed')  AS failed
  FROM deployment d
  GROUP BY d.ward_id
)
SELECT
  s.station_id,
  s.ward_id,
  s.name,
  s.expected_people,
  s.marshal_name,

  /* CHANGED 4. Deployments are made to a WARD, not to a station, so these
     counts are the ward's and every station in that ward carries the same
     figure. The spec named them supply_arrived / supply_failed on a station
     row, which reads as "this booth's supply" and would have had one failed
     drop show as five broken booths. Renamed to say what they are. */
  COALESCE(dp.arrived, 0)                          AS ward_supply_arrived,
  COALESCE(dp.partial, 0)                          AS ward_supply_partial,
  COALESCE(dp.failed,  0)                          AS ward_supply_failed,
  CASE WHEN COALESCE(dp.failed, 0) > 0 THEN 'SUPPLY_BROKEN'
       WHEN COALESCE(dp.partial, 0) > 0 THEN 'SUPPLY_PARTIAL'
       ELSE 'SUPPLY_OK' END                        AS supply_flag,

  COALESCE(l.people_on_site, 0)                    AS people_now,
  CASE
    WHEN l.reported_at IS NULL                          THEN 'NO_REPORT'
    WHEN l.minutes_since_report > cp.report_stale_minutes THEN 'STALE'
    WHEN COALESCE(l.people_on_site, 0) = 0              THEN 'UNSTAFFED'
    /* A station with no staffing plan cannot be understaffed against it.
       The spec compared against a possibly-null expected_people, which made
       the whole CASE null and fell through to STAFFED - a booth with two
       people and no plan read as fully staffed. */
    WHEN s.expected_people IS NULL                      THEN 'NO_PLAN'
    WHEN l.people_on_site < s.expected_people * cp.understaffed_ratio
                                                        THEN 'UNDERSTAFFED'
    ELSE 'STAFFED'
  END                                              AS presence_flag,

  COALESCE(l.queue, 'unknown')                     AS queue,
  COALESCE(l.problem_severity, 'none')             AS severity,
  l.problem,
  l.reported_at,
  l.minutes_since_report

FROM station s
CROSS JOIN control_panel cp
LEFT JOIN v_booth_status_live l ON l.station_id = s.station_id
LEFT JOIN deploy dp             ON dp.ward_id  = s.ward_id;

COMMENT ON VIEW v_booth_logistics IS
  'Per station: did the ward''s supply arrive, are our people there, is '
  'anything wrong. Supply figures are ward-level and shared by every '
  'station in that ward.';

CREATE VIEW v_logistics_rollup AS
SELECT
  COUNT(*) FILTER (WHERE supply_flag = 'SUPPLY_BROKEN')            AS supply_breaks,
  COUNT(*) FILTER (WHERE presence_flag = 'UNSTAFFED')              AS stations_unstaffed,
  COUNT(*) FILTER (WHERE presence_flag IN ('NO_REPORT','STALE'))   AS stations_blind,
  COUNT(*) FILTER (WHERE severity = 'high')                        AS active_high_problems,
  COUNT(*) FILTER (WHERE presence_flag = 'NO_PLAN')                AS stations_no_plan,
  COUNT(*)                                                         AS stations_total,
  ROUND(100.0 * COUNT(*) FILTER (WHERE presence_flag = 'STAFFED')
        / NULLIF(COUNT(*), 0), 1)                                  AS staffed_pct
FROM v_booth_logistics;

COMMENT ON VIEW v_logistics_rollup IS
  'Campaign-level logistics. stations_blind is the one to watch: a booth '
  'with no report is not a quiet booth, it is a booth nobody has heard from.';
