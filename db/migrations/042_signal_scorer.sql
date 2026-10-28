-- Record WHICH scorer produced each sentiment signal.
--
-- WHAT WAS MISSING. `Scorer.name` exists in the code - the lexicon scorer calls
-- itself 'keyword-v1' - it is threaded through src/sentiment/aggregate.ts, and
-- the ingest CLIs print it to the console on every run. It was never written to
-- the row. Every signal behind the 116 wards currently showing sentiment is
-- stored with no record of what scored it.
--
-- WHY IT MATTERS NOW RATHER THAN LATER. The `Tracking sentiment across Slang`
-- brief is right that keyword scoring fails on South African code-switched
-- text, and the fix is a new lexicon - which means a new scorer. The moment
-- that lands, this table holds two incompatible generations of score with
-- nothing to tell them apart, and every trend line drawn across the boundary
-- compares two different measuring instruments while looking like one. A
-- sentiment series that silently changes its own definition halfway through is
-- worse than one that is merely crude, because the crude one is at least
-- consistently crude.
--
-- This has to exist BEFORE the lexicon changes. Afterwards it cannot be
-- reconstructed: there is no way to look at a stored score and tell which
-- version of the word list produced it.
--
-- THE BACKFILL IS A CLAIM AND IT IS A TRUE ONE. Every row in this table was
-- written by the lexicon scorer; the alternative Python model path exists in
-- the CLIs behind --model but has not been run against this database. So
-- defaulting existing rows to 'keyword-v1' states a fact rather than papering
-- over an unknown. If that ever stops being true, this comment is the thing
-- that was wrong.

ALTER TABLE issue_signal
  ADD COLUMN IF NOT EXISTS scorer text;

UPDATE issue_signal SET scorer = 'keyword-v1' WHERE scorer IS NULL;

ALTER TABLE issue_signal
  ALTER COLUMN scorer SET DEFAULT 'keyword-v1';

-- NOT NULL only after the backfill, so the constraint describes the data
-- rather than demanding the insert supply something it has never supplied.
ALTER TABLE issue_signal
  ALTER COLUMN scorer SET NOT NULL;

COMMENT ON COLUMN issue_signal.scorer IS
  'Name and version of the scorer that produced net_sentiment and tone, e.g. '
  'keyword-v1. Required: a sentiment value without its scorer cannot be '
  'compared to one produced by a different lexicon or model, and a trend drawn '
  'across a scorer change is two instruments plotted as one.';

CREATE INDEX IF NOT EXISTS idx_issue_signal_scorer ON issue_signal (scorer);

-- Lets a reader see at a glance whether a series crosses a scorer boundary.
CREATE OR REPLACE VIEW v_signal_scorers AS
SELECT
  scorer,
  count(*)::int                        AS signals,
  count(DISTINCT ward_id)::int         AS wards,
  min(observed_on)                     AS first_observed,
  max(observed_on)                     AS last_observed,
  count(DISTINCT source)::int          AS sources
FROM issue_signal
GROUP BY scorer
ORDER BY signals DESC;

COMMENT ON VIEW v_signal_scorers IS
  'One row per scorer version with its date range. More than one row means the '
  'sentiment series changed instrument partway through, and any trend spanning '
  'the overlap needs saying so.';
