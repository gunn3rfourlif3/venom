-- THE COLLAPSE — mv_campaign_extract
--
-- When all ten views return correct results, they collapse into one
-- materialised view. The dashboard reads from mv_campaign_extract alone.
-- Everything else is lineage.
--
-- Refreshed on write, not nightly: a promotion or an operational write fires
-- NOTIFY extract_stale and a debounced worker runs REFRESH CONCURRENTLY.
-- Live returns on counting night bypass this view entirely and read the base
-- tables directly.
--
-- ONE ROW PER WARD. Asset holdings are aggregated per ward rather than joined
-- row-per-asset-type, which would fan the extract out and make every
-- ward-level figure double-count. The unique index below depends on that
-- property and REFRESH CONCURRENTLY depends on the unique index, so any
-- future column that multiplies rows per ward breaks the refresh, not just
-- the row count. For the per-asset-type breakdown, query v_asset_available.

CREATE MATERIALIZED VIEW mv_campaign_extract AS
SELECT
  e.ward_id,
  e.swing_index,
  e.rival_decline_share,
  e.pool_owner,
  e.peak_basis,

  c.registered_voters,
  c.our_pool_share,
  c.pool_size_2024,
  c.t2021_turnout,
  c.t2024_turnout,
  c.headroom,
  c.activation_gap,
  c.peak_turnout_pct,
  e.a_potential_votes,
  e.l_eroding_votes,
  e.l_abstention_votes,
  e.l_leakage_votes,
  e.leakage_basis,
  e.l_leakage_all,
  e.l_leakage_pool_share,
  e.l_leakage_own_vote,
  e.eo_est_votes,
  e.eo_act_votes,
  e.candidate_shortage,
  e.people_shortage,
  e.presence_shortage,

  p.municipality,
  p.zone,
  p.is_contestable,
  p.candidate_status,
  p.recommended_box,
  p.box_priority,
  p.priority_score,
  p.priority_rank,
  p.score_rank,
  p.gap_flag,

  r.reliability_ratio,
  r.weekend_premium,
  r.m1_discounted,
  r.m5_confidence,
  r.cost_per_body_claimed,
  r.cost_per_body_planned,

  b.stations_total,
  b.stations_covered,
  b.pledges_secured,

  COALESCE(f.assets_spend_first, 0)   AS assets_spend_first,
  COALESCE(f.assets_spend_second, 0)  AS assets_spend_second,
  COALESCE(f.assets_total, 0)         AS assets_total,

  now()                               AS as_of
FROM v_ward_eo e
LEFT JOIN v_ward_computed c    ON c.ward_id = e.ward_id
LEFT JOIN v_priority_rank p    ON p.ward_id = e.ward_id
LEFT JOIN v_ward_reliability r ON r.ward_id = e.ward_id
LEFT JOIN (
  SELECT ward_id,
         COUNT(*)                                          AS stations_total,
         COUNT(*) FILTER (WHERE coverage_flag = 'COVERED') AS stations_covered,
         SUM(pledges)                                      AS pledges_secured
  FROM v_booth_status GROUP BY ward_id
) b ON b.ward_id = e.ward_id
LEFT JOIN (
  SELECT location                                                  AS ward_id,
         SUM(quantity) FILTER (WHERE spend_order = 'SPEND_FIRST')  AS assets_spend_first,
         SUM(quantity) FILTER (WHERE spend_order = 'SPEND_SECOND') AS assets_spend_second,
         SUM(quantity)                                             AS assets_total
  FROM v_asset_available
  WHERE location_kind = 'ward'
  GROUP BY location
) f ON f.ward_id = e.ward_id;

-- UNIQUE so that REFRESH MATERIALIZED VIEW CONCURRENTLY works and the
-- rebuild does not take an exclusive lock on the dashboard's table.
CREATE UNIQUE INDEX idx_extract_ward ON mv_campaign_extract (ward_id);
CREATE INDEX        idx_extract_rank ON mv_campaign_extract (priority_rank);
CREATE INDEX        idx_extract_box  ON mv_campaign_extract (recommended_box);
