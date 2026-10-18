-- WINDOW 9 — v_campaign_eo
-- Input:  v_ward_eo, v_asset_available
-- Output: the campaign-level A, L, EO
--
-- Four numbers. The balance sheet in one row.
--
-- calibration_error stays NULL until iec_result is loaded, which is correct:
-- there is nothing to calibrate against before the declaration.

CREATE VIEW v_campaign_eo AS
SELECT
  SUM(a_potential_votes)                    AS a_total_votes,
  SUM(l_eroding_votes)                      AS l_total_votes,
  SUM(l_abstention_votes)                   AS l_abstention_votes,
  SUM(l_leakage_votes)                      AS l_leakage_votes,
  MIN(leakage_basis)                        AS leakage_basis,
  SUM(l_leakage_all)                        AS l_leakage_all,
  SUM(l_leakage_pool_share)                 AS l_leakage_pool_share,
  SUM(l_leakage_own_vote)                   AS l_leakage_own_vote,
  SUM(eo_est_votes)                         AS eo_est_votes,
  SUM(eo_act_votes)                         AS eo_act_votes,
  SUM(eo_act_votes) - SUM(eo_est_votes)     AS calibration_error,

  -- how much of the estimate has actually been declared, so a partial
  -- count is not mistaken for a finished one
  COUNT(*)                                  AS wards_total,
  COUNT(eo_act_votes)                       AS wards_declared,

  -- liability counts
  SUM(candidate_shortage)                   AS wards_no_candidate,
  SUM(people_shortage)                      AS people_gap_total,
  SUM(presence_shortage)                    AS wards_no_presence,

  -- asset counts
  (SELECT SUM(quantity) FROM v_asset_available
   WHERE asset_type = 'T-shirt' AND spend_order = 'SPEND_FIRST')  AS liq_tshirts,
  (SELECT SUM(quantity) FROM v_asset_available
   WHERE asset_type = 'T-shirt' AND spend_order = 'SPEND_SECOND') AS surplus_tshirts

FROM v_ward_eo;
