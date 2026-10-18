-- WINDOW 4 — v_asset_available
-- Input:  asset_holding, liquidatable
-- Output: what exists to deploy, in the order it should be spent
--
-- SPEND_FIRST is the liquidatables — free or near-free assets.
-- SPEND_SECOND is the ward surplus.
-- The order is the arbitrage hierarchy: other people's money before your own.

CREATE VIEW v_asset_available AS
SELECT
  'HOLDING'                       AS source,
  ward_id                         AS location,
  asset_type,
  SUM(quantity)                   AS quantity,
  NULL::numeric                   AS est_value,
  'SPEND_SECOND'                  AS spend_order
FROM asset_holding
WHERE status = 'Available'
GROUP BY ward_id, asset_type

UNION ALL

SELECT
  'LIQUIDATABLE'                   AS source,
  strategic_destination            AS location,
  resource_type                    AS asset_type,
  SUM(quantity)                    AS quantity,
  SUM(assessed_value - fetch_cost) AS est_value,
  'SPEND_FIRST'                    AS spend_order
FROM liquidatable
WHERE status <> 'Deployed'
  AND assessed_value > fetch_cost
GROUP BY strategic_destination, resource_type;
