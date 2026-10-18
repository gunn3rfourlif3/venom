-- Structured grievance: what is actually going wrong in a ward, now.
--
-- The rest of Venom measures the PAST (election arithmetic) and the present
-- INVENTORY (who and what we have). Neither says whether anything is moving.
-- In a municipal election what moves turnout is service delivery, and that
-- is hyperlocal and changes weekly.
--
-- THE BOUNDARY, and it is not advisory: this layer tracks ISSUES, NEVER
-- PEOPLE. No names, no contact details, no identity numbers, no attributed
-- quotes, no social posts tied to individuals. The moment it stores a
-- grievance attached to a named person it stops being campaign analytics
-- and becomes profiling - a POPIA problem, and a breach of the same
-- no-individual-records line the whole design rests on. The CHECK
-- constraints below enforce the cheap part of that; the rest is discipline.
--
-- Deliberately NOT a sentiment score. Ward-level social sentiment is thin
-- and badly geolocated, and a score computed on it would look quantitative
-- while being noise. Counts of attributable, dated, evidenced grievances
-- are worth more than an inferred mood.

CREATE TYPE issue_category AS ENUM (
  'Water','Electricity','Refuse','Roads','Housing',
  'Sanitation','Safety','Health','Transport','Billing','Other');

CREATE TYPE issue_severity AS ENUM ('Low','Moderate','High','Severe');

CREATE TABLE ward_issue (
  ward_issue_id bigserial     PRIMARY KEY,
  ward_id       text          NOT NULL REFERENCES ward (ward_id),
  category      issue_category NOT NULL,
  severity      issue_severity NOT NULL DEFAULT 'Moderate',

  -- One line on the grievance itself. About the SERVICE, never a person.
  summary       text          NOT NULL,

  first_seen    date          NOT NULL,
  last_seen     date          NOT NULL,
  resolved_at   date,

  -- A public source. Not a screenshot of a private group.
  evidence_url  text,

  recorded_by   text          NOT NULL REFERENCES app_user (user_id),
  recorded_at   timestamptz   NOT NULL DEFAULT now(),

  CONSTRAINT issue_dates_ordered    CHECK (last_seen >= first_seen),
  CONSTRAINT issue_resolved_after   CHECK (resolved_at IS NULL OR resolved_at >= first_seen),
  -- A 13-digit run is a South African ID number. Cheap structural guard
  -- against the boundary being crossed by habit rather than intent.
  CONSTRAINT issue_summary_no_id    CHECK (summary !~ '\d{13}'),
  -- and an obvious phone number
  CONSTRAINT issue_summary_no_phone CHECK (summary !~ '(\+27|\m0)\d{9}\M')
);

CREATE INDEX idx_ward_issue_ward ON ward_issue (ward_id);
CREATE INDEX idx_ward_issue_open ON ward_issue (ward_id, severity)
  WHERE resolved_at IS NULL;

COMMENT ON TABLE ward_issue IS
  'Dated, evidenced service-delivery grievances per ward. Issues, never '
  'people: no names, contact details, identity numbers or attributed quotes.';

-- Structured, published, geocodable, and a better predictor of local anger
-- than anything inferred from social media.
CREATE TABLE service_outage (
  service_outage_id bigserial     PRIMARY KEY,
  ward_id           text          REFERENCES ward (ward_id),   -- null = wider than one ward
  municipality      text,
  utility           issue_category NOT NULL,
  started_at        timestamptz   NOT NULL,
  ended_at          timestamptz,
  planned           boolean       NOT NULL DEFAULT false,

  source            text,
  source_url        text,
  source_fetched_at timestamptz,

  CONSTRAINT outage_ends_after_start CHECK (ended_at IS NULL OR ended_at >= started_at),
  CONSTRAINT outage_has_a_place      CHECK (ward_id IS NOT NULL OR municipality IS NOT NULL)
);

CREATE INDEX idx_outage_ward  ON service_outage (ward_id, started_at DESC);
CREATE INDEX idx_outage_start ON service_outage (started_at DESC);

-- Pressure thresholds live with every other tunable, not in a view.
ALTER TABLE control_panel
  ADD COLUMN pressure_window_days  integer NOT NULL DEFAULT 30
    CHECK (pressure_window_days BETWEEN 1 AND 365),
  ADD COLUMN pressure_elevated_at  integer NOT NULL DEFAULT 3
    CHECK (pressure_elevated_at >= 0),
  ADD COLUMN pressure_high_at      integer NOT NULL DEFAULT 7
    CHECK (pressure_high_at >= 0),
  ADD CONSTRAINT pressure_bands_ordered
    CHECK (pressure_high_at >= pressure_elevated_at);
