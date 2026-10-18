-- THE COLLAPSE — mv_campaign_extract
--
-- When all ten views return correct results, they collapse into one
-- materialised view. Refresh nightly. The dashboard reads from
-- mv_campaign_extract alone. Everything else is lineage.

CREATE MATERIALIZED VIEW mv_campaign_extract AS
SELECT
  e.ward_id,
  e.swing_index,
  e.pool_owner,
  e.eo_est_votes,
  e.eo_act_votes,
  e.candidate_shortage,
  e.people_shortage,
  e.presence_shortage,
  p.recommended_box,
  p.priority_score,
  p.priority_rank,
  p.gap_flag,
  r.reliability_ratio,
  r.weekend_premium,
  r.m1_discounted,
  b.stations_covered,
  b.pledges_secured,
  f.asset_type,
  f.quantity,
  f.spend_order
FROM v_ward_eo e
LEFT JOIN v_priority_rank p ON p.ward_id = e.ward_id
LEFT JOIN v_ward_reliability r ON r.ward_id = e.ward_id
LEFT JOIN (
  SELECT ward_id, COUNT(*) FILTER (WHERE contested_flag='COVERED') stations_covered,
         SUM(pledges) pledges_secured FROM v_booth_status GROUP BY ward_id
) b ON b.ward_id = e.ward_id
LEFT JOIN v_asset_available f ON f.location = e.ward_id;

CREATE INDEX idx_extract_ward ON mv_campaign_extract (ward_id);
CREATE INDEX idx_extract_rank ON mv_campaign_extract (priority_rank);
