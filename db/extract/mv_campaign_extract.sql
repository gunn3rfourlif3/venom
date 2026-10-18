-- THE COLLAPSE — mv_campaign_extract
--
-- When all ten views return correct results, they collapse into one
-- materialised view. Refresh nightly. The dashboard reads from
-- mv_campaign_extract alone. Everything else is lineage.
--
-- One row per ward. Asset holdings are aggregated per ward rather than
-- joined row-per-asset-type, which would fan the extract out and make
-- every ward-level figure double-count. For the per-asset-type breakdown,
-- query v_asset_available directly.

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
  COALESCE(f.assets_spend_first, 0)   AS assets_spend_first,
  COALESCE(f.assets_spend_second, 0)  AS assets_spend_second,
  COALESCE(f.assets_total, 0)         AS assets_total
FROM v_ward_eo e
LEFT JOIN v_priority_rank p    ON p.ward_id = e.ward_id
LEFT JOIN v_ward_reliability r ON r.ward_id = e.ward_id
LEFT JOIN (
  SELECT ward_id,
         COUNT(*) FILTER (WHERE coverage_flag = 'COVERED') AS stations_covered,
         SUM(pledges)                                      AS pledges_secured
  FROM v_booth_status GROUP BY ward_id
) b ON b.ward_id = e.ward_id
LEFT JOIN (
  SELECT location                                               AS ward_id,
         SUM(quantity) FILTER (WHERE spend_order='SPEND_FIRST')  AS assets_spend_first,
         SUM(quantity) FILTER (WHERE spend_order='SPEND_SECOND') AS assets_spend_second,
         SUM(quantity)                                           AS assets_total
  FROM v_asset_available GROUP BY location
) f ON f.ward_id = e.ward_id;

-- UNIQUE so that REFRESH MATERIALIZED VIEW CONCURRENTLY works and the
-- nightly rebuild does not take an exclusive lock on the dashboard's table.
CREATE UNIQUE INDEX idx_extract_ward ON mv_campaign_extract (ward_id);
CREATE INDEX        idx_extract_rank ON mv_campaign_extract (priority_rank);
