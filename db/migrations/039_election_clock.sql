-- The clock, and where the headline number actually comes from.
--
-- WHY THE DATE IS A SETTING AND NOT A CONSTANT. 4 November 2026 would be a
-- one-line literal in the dashboard, and it would be wrong by the first
-- by-election. The register, the wards and the slip pipeline all outlive this
-- election; the date they are counting towards has to be editable by someone
-- who is not deploying code.
--
-- WHY THE DRILLS SIT BESIDE IT. The drills on 29 and 31 October are the only
-- dates between now and polling day where the capture chain gets tested with
-- real people. A command centre that counts down to the election but not to
-- the rehearsal tells you about the deadline you cannot move and hides the
-- one you can still prepare for.

ALTER TABLE control_panel
  ADD COLUMN IF NOT EXISTS election_date date,
  ADD COLUMN IF NOT EXISTS drill_dates   date[] NOT NULL DEFAULT '{}';

UPDATE control_panel
   SET election_date = COALESCE(election_date, DATE '2026-11-04'),
       drill_dates   = CASE WHEN drill_dates = '{}'
                            THEN ARRAY[DATE '2026-10-29', DATE '2026-10-31']
                            ELSE drill_dates END;

ALTER TABLE control_panel
  ALTER COLUMN election_date SET NOT NULL;

COMMENT ON COLUMN control_panel.election_date IS
  'Polling day. A setting rather than a constant because the register and the '
  'capture pipeline outlive any one election.';
COMMENT ON COLUMN control_panel.drill_dates IS
  'Rehearsal dates for the capture chain. Counted down alongside polling day '
  'because they are the only dates where the chain is tested with real people.';

/* How much of the country the headline figure actually rests on.
 *
 * THIS EXISTS BECAUSE THE NUMBER LOOKS CERTAIN AND IS NOT. The expected
 * outcome renders at the top of the command centre in sixty-pixel type. On
 * 23 October every registered-voter figure behind it is SYNTHETIC and covers
 * 354 of 4,485 wards - the other 4,131 carry nothing at all. A reader has no
 * way to know that from the screen, and the one thing this project keeps
 * having to correct is an absence presented as an answer.
 *
 * So the coverage travels with the figure. If the roll is later loaded for
 * real, these counts change on their own and the caveat stops being shown -
 * nobody has to remember to take it down.
 */
CREATE OR REPLACE VIEW v_headline_provenance AS
SELECT
  count(*)::int                                                   AS wards_total,
  count(*) FILTER (WHERE registered_voters IS NOT NULL)::int       AS wards_with_roll,
  count(*) FILTER (WHERE roll_source = 'SYNTHETIC')::int           AS wards_synthetic,
  count(*) FILTER (WHERE registered_voters IS NOT NULL
                     AND roll_source IS DISTINCT FROM 'SYNTHETIC')::int
                                                                   AS wards_real,
  round(100.0 * count(*) FILTER (WHERE registered_voters IS NOT NULL)
        / NULLIF(count(*), 0), 1)                                  AS pct_covered
FROM ward;

COMMENT ON VIEW v_headline_provenance IS
  'What the expected-outcome figure rests on, so the command centre can say '
  'so beside it. wards_real is the one that matters: while it is zero the '
  'headline is entirely synthetic.';
