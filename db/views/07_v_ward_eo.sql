-- WINDOW 7 — v_ward_eo
-- Input:  v_ward_computed, v_ward_shortage, v_booth_status, iec_result, control_panel
-- Output: A, L, EO in votes — the ledger per ward
--
-- eo_act_votes is filled from the IEC booth count after the election.
-- The residual eo_act − eo_est is the calibration — the evidence that the
-- model was right or wrong.
--
-- peak_turnout_pct follows control_panel.peak_basis, so switching the basis
-- re-bases every figure below without editing this view.

CREATE VIEW v_ward_eo AS
WITH booth AS (
  SELECT ward_id,
         SUM(our_people)        AS people_at_booths,
         SUM(pledges)           AS pledges_total,
         COUNT(*) FILTER (WHERE coverage_flag = 'COVERED')
                                AS stations_covered
  FROM v_booth_status GROUP BY ward_id
),
basis AS (
  SELECT
    w.ward_id,
    w.swing_index,
    w.swing_share,
    w.pool_owner,
    w.peak_basis,
    -- A: potential votes if everything lands
    w.registered_voters * (w.peak_turnout_pct/100.0) * w.our_pool_share  AS a_raw,
    -- abstention against that potential
    w.registered_voters * (w.peak_turnout_pct/100.0) * w.our_pool_share
      * (1 - w.t2024_turnout/100.0)                                      AS abstention_raw,
    -- leakage from those who did turn out, at the configured rate
    w.registered_voters * (w.t2024_turnout/100.0) * cp.leakage_factor    AS leakage_raw
  FROM v_ward_computed w
  CROSS JOIN control_panel cp
)
SELECT
  b.ward_id,
  b.swing_index,
  b.swing_share,
  b.pool_owner,
  b.peak_basis,

  ROUND(b.a_raw)                                            AS a_potential_votes,
  ROUND(b.abstention_raw + b.leakage_raw)                   AS l_eroding_votes,
  ROUND(b.a_raw - (b.abstention_raw + b.leakage_raw))       AS eo_est_votes,

  -- the two halves of L, separated: they are different problems with
  -- different remedies, and a single total hides which one is biting
  ROUND(b.abstention_raw)                                   AS l_abstention_votes,
  ROUND(b.leakage_raw)                                      AS l_leakage_votes,

  -- liability lines for the workstreams
  s.candidate_shortage,
  s.people_shortage,
  s.presence_shortage,

  -- audit inputs
  COALESCE(bo.pledges_total, 0)                             AS pledges_secured,
  COALESCE(bo.stations_covered, 0)                          AS stations_covered,

  -- the IEC booth count, loaded after the election
  i.eo_act_votes

FROM basis b
LEFT JOIN v_ward_shortage s ON s.ward_id = b.ward_id
LEFT JOIN booth bo          ON bo.ward_id = b.ward_id
LEFT JOIN iec_result i      ON i.ward_id = b.ward_id;
