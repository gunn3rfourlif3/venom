-- WINDOW 5 — v_deployment_feasibility
-- Input:  deployment, v_ward_reliability, v_asset_available
-- Output: is this deployment actually executable?
--
-- One cell — feasibility — that stops a plan before it spends money.
--
-- NOTE: 80 (catering) and 150 (transport) are placeholders.
--       Pull from control_panel in production.

CREATE VIEW v_deployment_feasibility AS
WITH pool AS (
  SELECT asset_type, SUM(quantity) AS available
  FROM v_asset_available
  GROUP BY asset_type
)
SELECT
  d.deployment_id,
  d.ward_id,
  d.deploy_date,
  d.kitted_soldiers,
  d.action_type,

  COALESCE(r.m1_discounted, 0)                              AS ward_capacity,
  COALESCE(p.available, 0)                                  AS pool_tshirts,

  CASE WHEN d.kitted_soldiers <= COALESCE(r.m1_discounted,0)
        AND d.tshirts_drawn  <= COALESCE(p.available,0)
       THEN 'OK' ELSE 'SHORT' END                           AS feasibility,

  d.catering_headcount * 80                                 AS catering_cost,
  d.transport_bodies * 150                                  AS transport_cost

FROM deployment d
LEFT JOIN v_ward_reliability r ON r.ward_id = d.ward_id
LEFT JOIN pool p               ON p.asset_type = 'T-shirt';
