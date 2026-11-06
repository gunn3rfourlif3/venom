-- One slip, one count.
--
-- THE BUG THIS FIXES. Every query that tallies votes does this:
--
--   SUM(rv.votes) FROM result_vote rv JOIN result_transcription rt ...
--
-- A slip gets TWO transcriptions - double entry by two different people is
-- the whole quality mechanism, enforced in transcribe.ts - and each pass
-- writes its own result_vote rows. Summing across transcriptions therefore
-- counts every properly verified slip TWICE. Measured, not inferred: a slip
-- with 500 votes and two agreeing passes returns 1,000.
--
-- The effect is worst where it is least visible. A single-pass slip counts
-- once and a verified slip counts twice, so the overcount is not a clean
-- factor of two that someone would spot - it drifts between 1x and 2x as
-- transcription catches up through the night, which looks exactly like
-- results coming in. It would have doubled every seat projection on the 4th
-- while appearing to behave.
--
-- THE SHAPE OF THE MISTAKE IS FAMILIAR. The candidate table held 58,570 rows
-- for 29,285 candidates because a unique constraint over nullable columns can
-- never fire. Same family: a join that looks like it addresses one row per
-- real-world thing, but does not, and whose output is plausible enough that
-- nothing complains. Both were found by counting a known quantity rather
-- than by reading the query.
--
-- WHAT COUNTS, AND WHAT DOES NOT.
--
--   VERIFIED    two passes agreeing on every line. Counted. The lowest pass
--               is used; they are identical by definition of VERIFIED, so
--               the choice is arbitrary and recorded here so it stays
--               arbitrary in the same direction forever - a digest computed
--               today must recompute tomorrow.
--   TRANSCRIBED one pass so far. Counted, but flagged provisional, because
--               excluding it would mean showing nothing for the first hours
--               of the night.
--   DISPUTED    two passes that disagree. NOT counted. Not averaged, not
--               resolved by taking the first - the slip goes back to a human.
--               A disagreement about what a result slip says is not a number
--               to be split.
--   rejected / superseded  Not counted. `rejected` is text, not boolean:
--               `rejected IS NULL` is the accepted case.
--
-- DISPUTED being excluded rather than guessed is the one that needs saying
-- out loud, because it means the headline total is INCOMPLETE and not merely
-- provisional. v_tally_coverage reports disputed slips separately so that
-- absence is visible rather than inferred from a number that looks fine.

/* The chosen transcription per slip. One row per (slip), or none. */
CREATE OR REPLACE VIEW v_slip_counted AS
SELECT
  rs.slip_id,
  rs.station_id,
  rs.ballot,
  rs.status,
  (SELECT rt.transcription_id
     FROM result_transcription rt
    WHERE rt.slip_id = rs.slip_id
    ORDER BY rt.pass          -- fixed, so digests reproduce
    LIMIT 1)                                    AS transcription_id,
  (rs.status = 'VERIFIED')                      AS verified,
  (rs.status = 'TRANSCRIBED')                   AS provisional
FROM result_slip rs
WHERE rs.rejected IS NULL
  AND rs.superseded IS NOT TRUE
  -- DISPUTED is deliberately absent: see the header.
  AND rs.status IN ('VERIFIED', 'TRANSCRIBED');

COMMENT ON VIEW v_slip_counted IS
  'One counted transcription per accepted slip. DISPUTED slips are excluded, '
  'not resolved. Use this, never result_vote joined to result_transcription '
  'directly - that double-counts two-pass slips.';

/* Votes, deduplicated. This is the only correct way to read vote totals. */
CREATE OR REPLACE VIEW v_tally_vote AS
SELECT
  sc.slip_id,
  sc.station_id,
  st.ward_id,
  w.demarcation_code,
  w.province,
  sc.ballot,
  sc.status,
  sc.verified,
  sc.provisional,
  rv.party,
  rv.votes
FROM v_slip_counted sc
JOIN result_vote rv ON rv.transcription_id = sc.transcription_id
JOIN station st     ON st.station_id = sc.station_id
JOIN ward w         ON w.ward_id = st.ward_id;

COMMENT ON VIEW v_tally_vote IS
  'Canonical vote source: one row per party per accepted slip. '
  'SUM(votes) over this is correct; summing result_vote directly is not.';

/* Coverage, which a commitment digest pins alongside its counts. A total
   without its denominator is not a claim anyone can check: 4.2m votes is a
   different statement at 12% of slips than at 94%. */
CREATE OR REPLACE VIEW v_tally_coverage AS
WITH slips AS (
  SELECT
    w.province,
    w.demarcation_code,
    COUNT(*)                                                    AS slips_total,
    COUNT(*) FILTER (WHERE rs.status = 'VERIFIED')              AS slips_verified,
    COUNT(*) FILTER (WHERE rs.status = 'TRANSCRIBED')           AS slips_provisional,
    COUNT(*) FILTER (WHERE rs.status = 'DISPUTED')              AS slips_disputed,
    COUNT(*) FILTER (WHERE rs.rejected IS NOT NULL)             AS slips_rejected,
    COUNT(*) FILTER (WHERE rs.superseded IS TRUE)               AS slips_superseded
  FROM result_slip rs
  JOIN station st ON st.station_id = rs.station_id
  JOIN ward w     ON w.ward_id = st.ward_id
  GROUP BY w.province, w.demarcation_code
),
expected AS (
  /* Ballots per station by municipal category: a metro has two (ward + PR),
     a local council three (ward + local PR + district). Category comes from
     the demarcation code's first two characters, which is how this codebase
     already distinguishes them. */
  SELECT
    w.province,
    w.demarcation_code,
    COUNT(DISTINCT st.station_id)
      * CASE WHEN m.category = 'A' THEN 2 ELSE 3 END                AS slips_expected
  FROM ward w
  JOIN station st      ON st.ward_id = w.ward_id
  JOIN municipality m  ON m.demarcation_code = w.demarcation_code
  WHERE m.is_active IS NOT FALSE
  GROUP BY w.province, w.demarcation_code, m.category
)
SELECT
  e.province,
  e.demarcation_code,
  e.slips_expected,
  COALESCE(s.slips_total,       0) AS slips_seen,
  COALESCE(s.slips_verified,    0) AS slips_verified,
  COALESCE(s.slips_provisional, 0) AS slips_provisional,
  COALESCE(s.slips_disputed,    0) AS slips_disputed,
  COALESCE(s.slips_rejected,    0) AS slips_rejected,
  COALESCE(s.slips_superseded,  0) AS slips_superseded,
  /* Counted = what SUM over v_tally_vote actually covers. Not slips_seen:
     disputed and rejected slips are seen and not counted, and conflating
     the two is how a commitment ends up overstating its own coverage. */
  COALESCE(s.slips_verified, 0) + COALESCE(s.slips_provisional, 0)
                                   AS slips_counted,
  ROUND(100.0 * (COALESCE(s.slips_verified, 0) + COALESCE(s.slips_provisional, 0))
        / NULLIF(e.slips_expected, 0), 1) AS counted_pct
FROM expected e
LEFT JOIN slips s ON s.demarcation_code = e.demarcation_code
                 AND s.province = e.province;

COMMENT ON VIEW v_tally_coverage IS
  'Slip coverage per municipality. slips_counted is what v_tally_vote covers; '
  'disputed and rejected slips are reported separately, never folded in.';

/* Prove the deduplication, with the case that exposed the bug: one slip,
   two agreeing passes, 500 votes. The naive join returns 1,000. If this
   view ever returns 1,000 again, the migration fails rather than the seat
   projection silently doubling. */
DO $$
DECLARE
  v_station bigint;
  v_slip    bigint;
  v_who1    text;
  v_who2    text;
  v_tid     bigint;
  v_naive   bigint;
  v_correct bigint;
BEGIN
  SELECT station_id INTO v_station FROM station LIMIT 1;
  SELECT phone INTO v_who1 FROM reporter_roster ORDER BY phone LIMIT 1;
  SELECT phone INTO v_who2 FROM reporter_roster ORDER BY phone OFFSET 1 LIMIT 1;

  IF v_station IS NULL OR v_who1 IS NULL OR v_who2 IS NULL THEN
    RAISE NOTICE '054: no station or too few roster members - dedup check skipped';
    RETURN;
  END IF;

  INSERT INTO result_slip
    (station_id, ballot, image_path, image_sha256, image_bytes, captured_by, status)
  VALUES
    (v_station, 'WARD', '__dedup_selftest__', repeat('e', 64), 1, v_who1, 'VERIFIED')
  RETURNING slip_id INTO v_slip;

  FOR i IN 1..2 LOOP
    INSERT INTO result_transcription
      (slip_id, pass, entered_by, spoilt, total_votes_cast)
    VALUES
      (v_slip, i, CASE i WHEN 1 THEN v_who1 ELSE v_who2 END, 0, 500)
    RETURNING transcription_id INTO v_tid;
    INSERT INTO result_vote VALUES (v_tid, '__SELFTEST__', 500);
  END LOOP;

  SELECT SUM(rv.votes) INTO v_naive
    FROM result_vote rv
    JOIN result_transcription rt USING (transcription_id)
   WHERE rt.slip_id = v_slip;

  SELECT SUM(votes) INTO v_correct
    FROM v_tally_vote WHERE slip_id = v_slip;

  IF v_naive <> 1000 THEN
    RAISE EXCEPTION
      '054: the double-count case did not reproduce (naive join gave %, '
      'expected 1000) - the fixture no longer exercises the bug', v_naive;
  END IF;
  IF v_correct <> 500 THEN
    RAISE EXCEPTION
      '054: v_tally_vote returned % for a 500-vote slip - deduplication '
      'is not working', v_correct;
  END IF;

  /* result_transcription is append-only by trigger (029), so the fixture is
     removed by deleting the slip and letting the cascade take the rest. The
     trigger is stood down for that one statement only. */
  ALTER TABLE result_transcription DISABLE TRIGGER USER;
  DELETE FROM result_vote WHERE party = '__SELFTEST__';
  DELETE FROM result_transcription WHERE slip_id = v_slip;
  DELETE FROM result_slip WHERE slip_id = v_slip;
  ALTER TABLE result_transcription ENABLE TRIGGER USER;

  RAISE NOTICE '054: verified - naive join doubles (1000), v_tally_vote does not (500)';
END
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM result_slip WHERE image_path = '__dedup_selftest__')
     OR EXISTS (SELECT 1 FROM result_vote WHERE party = '__SELFTEST__') THEN
    RAISE EXCEPTION '054: self-test rows survived into the results table';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'result_transcription'::regclass
       AND NOT tgisinternal AND tgenabled = 'O') THEN
    RAISE EXCEPTION '054: result_transcription triggers were left disabled';
  END IF;
  RAISE NOTICE '054: clean - fixtures removed, append-only triggers armed';
END
$$;
