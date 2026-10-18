-- WINDOW 9 — v_campaign_eo
-- Input:  v_ward_eo, v_asset_available, v_ward_shortage
-- Output: the campaign-level A, L, EO
--
-- Four numbers. The balance sheet in one row.

CREATE VIEW v_campaign_eo AS
SELECT
  SUM(a_potential_votes)                    AS a_total_votes,
  SUM(l_eroding_votes)                      AS l_total_votes,
  SUM(eo_est_votes)                         AS eo_est_votes,
  SUM(eo_act_votes)                         AS eo_act_votes,
  SUM(eo_act_votes) - SUM(eo_est_votes)     AS calibration_error,

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
