-- WINDOW 4 — v_asset_available
-- Input:  asset_holding, liquidatable, location
-- Output: what exists to deploy, in the order it should be spent
--
-- SPEND_FIRST is the liquidatables — free or near-free assets.
-- SPEND_SECOND is the ward surplus.
-- The order is the arbitrage hierarchy: other people's money before your own.

CREATE VIEW v_asset_available AS
SELECT
  'HOLDING'                        AS source,
  ah.location_id                   AS location,
  l.kind                           AS location_kind,
  ah.asset_type,
  SUM(ah.quantity)                 AS quantity,
  NULL::numeric                    AS est_value,
  'SPEND_SECOND'                   AS spend_order
FROM asset_holding ah
JOIN location l ON l.location_id = ah.location_id
WHERE ah.status = 'Available'
GROUP BY ah.location_id, l.kind, ah.asset_type

UNION ALL

SELECT
  'LIQUIDATABLE'                             AS source,
  lq.strategic_destination                   AS location,
  l.kind                                     AS location_kind,
  lq.resource_type                           AS asset_type,
  SUM(lq.quantity)                           AS quantity,
  SUM(lq.assessed_value - lq.fetch_cost)     AS est_value,
  'SPEND_FIRST'                              AS spend_order
FROM liquidatable lq
JOIN location l ON l.location_id = lq.strategic_destination
WHERE lq.status NOT IN ('Deployed', 'Written off')
  AND lq.assessed_value > lq.fetch_cost
GROUP BY lq.strategic_destination, l.kind, lq.resource_type;
