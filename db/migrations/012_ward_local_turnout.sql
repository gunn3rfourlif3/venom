-- t2021_turnout — the last LOCAL GOVERNMENT turnout for the ward.
--
-- The model was missing the one baseline a municipal contest should be
-- measured against. Everything about turnout shortfall was computed against
-- t2024_turnout, which is a NATIONAL figure, and national turnout is
-- structurally higher than local. The consequences, confirmed on 523 wards:
--
--   activation_gap  peak_all equalled t2024_turnout in 523 of 523 wards, so
--                   the subtraction was x - x; on the LGE basis peak_lge was
--                   below t2024_turnout in 523 of 523, so it floored to zero.
--                   The column could not return a non-zero value either way.
--
--   headroom        registered x (1 - national turnout) understates the
--                   non-voter pool available at a local election, and
--                   headroom is 30% of the priority score.
--
-- Scrapable: it is PercVoterTurnout on the LGE ward results already fetched.

ALTER TABLE ward
  ADD COLUMN t2021_turnout numeric(5,2)
    CHECK (t2021_turnout >= 0 AND t2021_turnout <= 100);

COMMENT ON COLUMN ward.t2021_turnout IS
  'Turnout % at the last local government election. The baseline for '
  'headroom, activation_gap and abstention: the contest being fought is '
  'local, so the comparison must be local.';

COMMENT ON COLUMN ward.t2024_turnout IS
  'Turnout % at the 2024 national election. Not comparable with local '
  'turnout - use t2021_turnout for anything measuring local shortfall.';
