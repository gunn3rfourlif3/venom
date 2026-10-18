-- WINDOW 7 — v_ward_eo
-- Input:  v_ward_computed, v_ward_shortage, v_booth_status, station
-- Output: A, L, EO in votes — the ledger per ward
--
-- eo_act_votes is filled from the IEC booth count after the election.
-- The residual eo_act − eo_est is the calibration — the evidence that
-- the model was right or wrong.

CREATE VIEW v_ward_eo AS
WITH booth AS (
  SELECT ward_id,
         SUM(our_people)        AS people_at_booths,
         SUM(pledges)           AS pledges_total,
         COUNT(*) FILTER (WHERE contested_flag = 'COVERED')
                                AS stations_covered
  FROM v_booth_status GROUP BY ward_id
)
SELECT
  w.ward_id,
  w.swing_index,
  w.pool_owner,

  -- A: potential votes if everything lands
  ROUND(w.registered_voters * (w.peak_turnout_pct/100.0)
        * w.our_pool_share)                                 AS a_potential_votes,

  -- L: abstention + leakage
  ROUND(
    (w.registered_voters * (w.peak_turnout_pct/100.0) * w.our_pool_share)
      * (1 - w.t2024_turnout/100.0)
    +
    (w.registered_voters * (w.t2024_turnout/100.0))
      * 0.10                                                -- leakage placeholder
  )                                                         AS l_eroding_votes,

  -- EO
  ROUND(
    (w.registered_voters * (w.peak_turnout_pct/100.0) * w.our_pool_share)
    -
    (
      (w.registered_voters * (w.peak_turnout_pct/100.0) * w.our_pool_share)
        * (1 - w.t2024_turnout/100.0)
      +
      (w.registered_voters * (w.t2024_turnout/100.0)) * 0.10
    )
  )                                                         AS eo_est_votes,

  -- liability lines for the workstreams
  s.candidate_shortage,
  s.people_shortage,
  s.presence_shortage,

  -- audit inputs
  COALESCE(b.pledges_total, 0)                              AS pledges_secured,
  COALESCE(b.stations_covered, 0)                           AS stations_covered,

  -- placeholder for the booth count
  NULL::integer                                             AS eo_act_votes

FROM v_ward_computed w
LEFT JOIN v_ward_shortage s ON s.ward_id = w.ward_id
LEFT JOIN booth b           ON b.ward_id = w.ward_id;
