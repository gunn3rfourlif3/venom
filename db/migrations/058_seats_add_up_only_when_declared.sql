-- An invariant that only holds once the count is finished.
--
-- 057 constrained every IEC row to total_seats_won = ward + pr. That is true
-- of a declared result and NOT true of a council still counting, so the
-- constraint threw away exactly the rows worth watching tonight.
--
-- The case that found it: MP321 Thaba Chweu, 46 of 47 voting districts in.
-- The ANC row reads ward 11, PR 0, total 12.
--
-- That is not a data error. Municipal PR is compensatory: a party's total
-- entitlement is computed from votes, and its PR seats are that entitlement
-- MINUS the ward seats it already won. Mid-count the IEC can know the
-- entitlement (12) before the PR allocation settles, so total runs ahead of
-- ward + pr by exactly the seats the last districts will decide. Across the
-- council, ward and PR each sum to 13 against 27 available - one seat short,
-- which is the one district still out.
--
-- So the rule is right about a result and wrong about a snapshot, and the
-- constraint is narrowed to say so rather than dropped. A row that claims to
-- be complete must still add up; one that does not claim to be complete is
-- allowed to be mid-flight, and is already marked as such.
--
-- WORTH NOTING FOR THE SEAT ENGINE. This is independent confirmation of the
-- rule the engine implements - PR seats = total entitlement − ward seats won
-- - visible in the IEC's own intermediate output. It is the clearest
-- evidence yet that the engine's compensatory model matches theirs.

ALTER TABLE iec_municipality_result DROP CONSTRAINT IF EXISTS seats_add_up;

ALTER TABLE iec_municipality_result
  ADD CONSTRAINT seats_add_up_when_declared CHECK (
    NOT is_complete OR total_seats_won = ward_seats_won + pr_seats_won);

COMMENT ON CONSTRAINT seats_add_up_when_declared ON iec_municipality_result IS
  'Ward + PR must equal the total only for a council the IEC reports '
  'complete. Mid-count, the compensatory total entitlement legitimately runs '
  'ahead of the settled allocation.';

/* Make the gap visible rather than leaving it to be rediscovered. */
CREATE OR REPLACE VIEW v_iec_pending_seats AS
SELECT
  r.demarcation_code,
  m.name                                   AS municipality,
  m.province_name                          AS province,
  r.party,
  r.ward_seats_won,
  r.pr_seats_won,
  r.total_seats_won,
  r.total_seats_won - (r.ward_seats_won + r.pr_seats_won) AS seats_not_yet_settled,
  r.counted_vds,
  r.expected_vds,
  r.expected_vds - r.counted_vds           AS vds_outstanding
FROM iec_municipality_result r
JOIN municipality m ON m.demarcation_code = r.demarcation_code
WHERE NOT r.is_complete
  AND r.total_seats_won <> r.ward_seats_won + r.pr_seats_won;

COMMENT ON VIEW v_iec_pending_seats IS
  'Parties whose IEC total entitlement runs ahead of their settled ward+PR '
  'allocation, with the districts still outstanding. Expected mid-count; '
  'should be empty once every council is declared.';

/* Prove both halves: a complete row must add up, an incomplete one need not. */
DO $$
DECLARE
  code text;
  ok boolean;
BEGIN
  SELECT demarcation_code INTO code FROM municipality WHERE is_active LIMIT 1;
  IF code IS NULL THEN
    RAISE NOTICE '058: no municipality to test against - check skipped';
    RETURN;
  END IF;

  -- Incomplete and not adding up: permitted.
  INSERT INTO iec_municipality_result
    (demarcation_code, electoral_event, party, ward_votes, pr_votes,
     total_valid_votes, ward_seats_won, pr_seats_won, total_seats_won,
     available_seats, is_complete, report_date, source_url)
  VALUES (code, '__SELFTEST__', 'MIDCOUNT', 0, 0, 0, 11, 0, 12, 27,
          false, now(), 'self-test');

  -- Complete and not adding up: refused.
  ok := false;
  BEGIN
    INSERT INTO iec_municipality_result
      (demarcation_code, electoral_event, party, ward_votes, pr_votes,
       total_valid_votes, ward_seats_won, pr_seats_won, total_seats_won,
       available_seats, is_complete, report_date, source_url)
    VALUES (code, '__SELFTEST__', 'DECLARED', 0, 0, 0, 11, 0, 12, 27,
            true, now(), 'self-test');
  EXCEPTION WHEN check_violation THEN ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION '058: a declared result that does not add up was accepted';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM v_iec_pending_seats
                  WHERE party = 'MIDCOUNT' AND seats_not_yet_settled = 1) THEN
    RAISE EXCEPTION '058: the pending-seats view did not surface the mid-count row';
  END IF;

  DELETE FROM iec_municipality_result WHERE electoral_event = '__SELFTEST__';
  RAISE NOTICE '058: verified - mid-count rows allowed, declared rows must add up';
END
$$;
