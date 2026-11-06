-- The IEC's own 2026 results, kept apart from ours.
--
-- WHY A SEPARATE TABLE AND NOT result_vote.
--
-- These are the IEC's published figures, read from the results dashboard.
-- They are not slips this campaign captured, and the two must never be
-- summed, joined, or allowed to stand in for one another. If IEC figures
-- could reach result_vote, then `v_tally_vote` would include them, a tally
-- commitment would seal them, and the chain would be certifying numbers
-- copied from the IEC as though they were independently captured. That is
-- precisely the claim the commitment module exists to make checkable, and
-- quietly making it false in the data model would be worse than not having
-- built it.
--
-- So: own capture lives in result_slip / result_transcription / result_vote.
-- The IEC's published results live here. Nothing joins them except code
-- that is explicitly comparing the two, which is the point.
--
-- WHAT IT IS FOR.
--
-- 1. Validating the seat engine. The engine reproduces Sol Plaatje and
--    Madibeng 2021 exactly, which is two councils. This is 213, with the
--    IEC's own declared ward and PR seats to check against. An engine that
--    cannot reproduce 213 real allocations has no business projecting one.
-- 2. A 2026 baseline for later work, replacing the 2021 baseline that was
--    never obtainable because the IEC credentials never arrived. It turns
--    out the dashboard needs none.
--
-- WHAT IT IS NOT. Not official until the IEC declares, and a row loaded
-- mid-count is a snapshot of an incomplete count. counted_vds / expected_vds
-- are stored per municipality so a partial row can never be mistaken for a
-- final one, and `is_complete` is recorded rather than inferred.

CREATE TABLE IF NOT EXISTS iec_municipality_result (
  demarcation_code  text    NOT NULL REFERENCES municipality (demarcation_code),
  electoral_event   text    NOT NULL,          -- 'EEID1887' for 2026
  party             text    NOT NULL,

  ward_votes        integer NOT NULL CHECK (ward_votes >= 0),
  pr_votes          integer NOT NULL CHECK (pr_votes   >= 0),
  total_valid_votes integer NOT NULL CHECK (total_valid_votes >= 0),

  -- As DECLARED by the IEC. The engine's own numbers are never written
  -- here; the whole use of this table is having something to disagree with.
  ward_seats_won    integer NOT NULL CHECK (ward_seats_won  >= 0),
  pr_seats_won      integer NOT NULL CHECK (pr_seats_won    >= 0),
  total_seats_won   integer NOT NULL CHECK (total_seats_won >= 0),
  available_seats   integer NOT NULL CHECK (available_seats >  0),

  registered_voters integer,
  total_votes_cast  integer,
  spoilt_votes      integer,

  -- Completeness travels with the row, so a partial count cannot be read
  -- as a final one later. The same rule as tally commitments carrying their
  -- own coverage: a figure without its denominator is not checkable.
  counted_vds       integer,
  expected_vds      integer,
  is_complete       boolean NOT NULL,

  report_date       timestamptz NOT NULL,
  fetched_at        timestamptz NOT NULL DEFAULT now(),
  source_url        text    NOT NULL,

  PRIMARY KEY (demarcation_code, electoral_event, party),

  CONSTRAINT seats_add_up CHECK (total_seats_won = ward_seats_won + pr_seats_won)
);

COMMENT ON TABLE iec_municipality_result IS
  'IEC-published per-party results by council. NOT own capture - never join '
  'or sum with result_vote. Used to validate the seat engine and as a 2026 '
  'baseline.';
COMMENT ON COLUMN iec_municipality_result.is_complete IS
  'The IEC reported this council complete when the row was fetched. A row '
  'loaded mid-count is a snapshot, not a result.';

CREATE INDEX IF NOT EXISTS iec_municipality_result_event_idx
  ON iec_municipality_result (electoral_event, demarcation_code);

/* Voting-district detail. Separate table because it is ~24,000 districts x
   parties and most work never needs it, and because it arrives from a
   different file per municipality - so a partial load of this must not make
   the council-level table look partial. */
CREATE TABLE IF NOT EXISTS iec_vd_result (
  vd_number         text    NOT NULL,
  electoral_event   text    NOT NULL,
  demarcation_code  text    NOT NULL REFERENCES municipality (demarcation_code),
  ward_code         text,
  ballot            text,
  party             text    NOT NULL,
  votes             integer NOT NULL CHECK (votes >= 0),
  report_date       timestamptz,
  fetched_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (vd_number, electoral_event, ballot, party)
);

COMMENT ON TABLE iec_vd_result IS
  'IEC-published results per voting district. NOT own capture. Loaded '
  'separately from the council-level table and may lag it.';

CREATE INDEX IF NOT EXISTS iec_vd_result_munic_idx
  ON iec_vd_result (electoral_event, demarcation_code);

/* Engine against reality. The comparison is a view rather than a report so
   that it is always available and always current - a validation you have to
   remember to run is one that stops being run. */
CREATE OR REPLACE VIEW v_iec_seat_comparison AS
SELECT
  r.demarcation_code,
  m.name                        AS municipality,
  m.province_name               AS province,
  r.electoral_event,
  r.party,
  r.ward_votes,
  r.pr_votes,
  r.ward_seats_won              AS iec_ward_seats,
  r.pr_seats_won                AS iec_pr_seats,
  r.total_seats_won             AS iec_total_seats,
  r.available_seats,
  cs.total_seats                AS our_total_seats,
  cs.ward_seats                 AS our_ward_seats,
  r.is_complete,
  r.counted_vds,
  r.expected_vds,
  -- Does the IEC's own council size match the one we loaded into
  -- council_seats? They come from the same place, so a mismatch means
  -- something was written over in between.
  (cs.total_seats IS NOT DISTINCT FROM r.available_seats) AS seat_total_agrees
FROM iec_municipality_result r
JOIN municipality m   ON m.demarcation_code = r.demarcation_code
LEFT JOIN council_seats cs ON cs.demarcation_code = r.demarcation_code;

COMMENT ON VIEW v_iec_seat_comparison IS
  'IEC declared seats beside our stored council sizes. The engine''s own '
  'allocation is compared by npm run seats:verify-2026, not here.';
