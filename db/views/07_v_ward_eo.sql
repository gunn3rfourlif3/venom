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
    w.rival_decline_share,
    w.pool_owner,
    w.peak_basis,
    -- A: potential votes if everything lands
    w.registered_voters * (w.peak_turnout_pct/100.0) * w.our_pool_share  AS a_raw,
    -- Abstention against that potential, measured from the last LOCAL
    -- turnout. Using the national turnout here understated abstention,
    -- because national turnout is structurally higher than local.
    w.registered_voters * (w.peak_turnout_pct/100.0) * w.our_pool_share
      * (1 - w.t2021_turnout/100.0)                                      AS abstention_raw,
    -- THREE READINGS OF LEAKAGE, all computed so they can be compared.
    -- control_panel.leakage_basis selects which one eo_est_votes follows.
    --   ALL         ten per cent of EVERY vote cast in the ward. The
    --               original, and wrong: it charges the rival's voters
    --               against us. Kept for comparison; gives a negative EO
    --               in most wards.
    --   POOL_SHARE  our share of that whole-electorate drift.
    --   OWN_VOTE    ten per cent of the people who actually voted for us.
    w.registered_voters * (w.t2024_turnout/100.0) * cp.leakage_factor    AS leak_all,
    w.registered_voters * (w.t2024_turnout/100.0) * cp.leakage_factor
      * w.our_pool_share                                                 AS leak_pool_share,
    w.t2024_mkp * cp.leakage_factor                                      AS leak_own_vote,
    cp.leakage_basis,
    CASE cp.leakage_basis
      WHEN 'ALL'        THEN w.registered_voters * (w.t2024_turnout/100.0) * cp.leakage_factor
      WHEN 'POOL_SHARE' THEN w.registered_voters * (w.t2024_turnout/100.0) * cp.leakage_factor
                             * w.our_pool_share
      ELSE                   w.t2024_mkp * cp.leakage_factor
    END                                                                  AS leakage_raw
  FROM v_ward_computed w
  CROSS JOIN control_panel cp
)
SELECT
  b.ward_id,
  b.swing_index,
  b.rival_decline_share,
  b.pool_owner,
  b.peak_basis,

  ROUND(b.a_raw)                                            AS a_potential_votes,
  ROUND(b.abstention_raw + b.leakage_raw)                   AS l_eroding_votes,
  ROUND(b.a_raw - (b.abstention_raw + b.leakage_raw))       AS eo_est_votes,

  -- the two halves of L, separated: they are different problems with
  -- different remedies, and a single total hides which one is biting
  ROUND(b.abstention_raw)                                   AS l_abstention_votes,
  ROUND(b.leakage_raw)                                      AS l_leakage_votes,

  -- all three bases exposed, so switching the setting is an informed choice
  -- rather than a leap, and so a dashboard can show the spread
  b.leakage_basis,
  ROUND(b.leak_all)                                         AS l_leakage_all,
  ROUND(b.leak_pool_share)                                  AS l_leakage_pool_share,
  ROUND(b.leak_own_vote)                                    AS l_leakage_own_vote,

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
