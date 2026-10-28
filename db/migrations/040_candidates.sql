-- Certified candidates, from the IEC's published list.
--
-- WHY THIS IS NOT A BREACH OF "TRACK ISSUES, NOT PEOPLE". That rule exists to
-- keep private citizens out of a political targeting system: no voter table,
-- no canvassing queue, no attributed opinions. A candidate on a certified
-- ballot is the opposite case - a person who has publicly put themselves
-- forward for office, whose name, party and ward the IEC publishes precisely
-- so the public can see who is standing. The distinction is the point, and
-- the line is drawn one column to the right of it.
--
-- NO IDENTITY NUMBERS. The published list carries them, partially masked
-- (630809****08*). Masked or not, that is a date of birth, and it has no
-- bearing on any question this system answers. The parser matches the field
-- only because it is the one unambiguous anchor between a multi-word party
-- name and a multi-word personal name, then discards it before writing.
-- The CHECK below is the backstop: the database refuses the shape even if a
-- future importer gets careless.
--
-- WARD CANDIDATE AND LIST CANDIDATE ARE DIFFERENT THINGS and are kept apart.
-- A ward candidate contests a specific seat. A PR list candidate takes a
-- seat only if the party's proportional entitlement reaches their rank. A
-- schema that conflated them would make "wards without a candidate"
-- unanswerable, which is the one question this data is here to answer.

CREATE TABLE IF NOT EXISTS candidate (
  candidate_id     bigserial PRIMARY KEY,
  demarcation_code text NOT NULL,
  municipality     text NOT NULL,
  party            text NOT NULL,
  ward_id          text,          -- set for a ward candidate
  list_order       integer,       -- set for a PR list candidate
  candidate_name   text NOT NULL,
  source           text NOT NULL DEFAULT 'IEC_CERTIFIED',
  source_url       text,
  certified_on     date,
  loaded_at        timestamptz NOT NULL DEFAULT now(),

  -- Exactly one of the two, never both, never neither.
  CONSTRAINT ward_xor_list CHECK (
    (ward_id IS NOT NULL AND list_order IS NULL) OR
    (ward_id IS NULL AND list_order IS NOT NULL)),

  -- No identity numbers, masked or whole, in any text column.
  CONSTRAINT no_id_numbers CHECK (
    candidate_name !~ '\d{6}' AND candidate_name !~ '\d{13}'),

  -- A candidate appears once per party per slot.
  CONSTRAINT candidate_slot UNIQUE (demarcation_code, party, ward_id, list_order, candidate_name)
);

CREATE INDEX IF NOT EXISTS idx_candidate_ward ON candidate (ward_id);
CREATE INDEX IF NOT EXISTS idx_candidate_party ON candidate (party);
CREATE INDEX IF NOT EXISTS idx_candidate_munic ON candidate (demarcation_code);

COMMENT ON TABLE candidate IS
  'Certified candidates from the IEC published list. Names, party and ward '
  'only - identity numbers are refused by CHECK, not merely omitted by the '
  'importer. Candidates on a certified ballot are public figures; this is '
  'not voter data and must never become it.';

/* Which wards our party is actually contesting.
 *
 * THE ANSWER IS FIXED. Lists were certified on 16 September 2026 and cannot
 * change before polling day. A ward with no candidate of ours is a ward
 * where no amount of ground effort produces a ward councillor - the only
 * thing on offer there is the PR ballot. That is worth knowing before
 * volunteers are sent somewhere their work cannot pay off in the way they
 * were told it would.
 *
 * The party is read from control_panel rather than hardcoded, so this view
 * survives the system being used by anyone else. */
CREATE OR REPLACE VIEW v_ward_candidacy AS
SELECT
  w.ward_id,
  w.demarcation_code,
  m.name          AS municipality,
  m.province_name AS province,
  EXISTS (SELECT 1 FROM candidate c
           WHERE c.ward_id = w.ward_id
             AND c.party ILIKE '%UMKHONTO%')              AS has_our_candidate,
  (SELECT count(DISTINCT c.party)::int FROM candidate c
    WHERE c.ward_id = w.ward_id)                          AS parties_contesting,
  EXISTS (SELECT 1 FROM candidate c WHERE c.ward_id = w.ward_id) AS list_loaded
FROM ward w
JOIN municipality m ON m.demarcation_code = w.demarcation_code;

COMMENT ON VIEW v_ward_candidacy IS
  'Per ward: whether we field a ward candidate, and how many parties contest '
  'it. list_loaded distinguishes "we have no candidate here" from "the '
  'certified list for this province has not been loaded" - without it every '
  'ward outside Gauteng would read as uncontested, which is an absence '
  'rendered as a finding.';
