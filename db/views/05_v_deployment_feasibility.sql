-- WINDOW 5 — v_deployment_feasibility
-- Input:  deployment, v_ward_reliability, v_asset_available, control_panel
-- Output: is this deployment actually executable, and what does it spend first
--
-- One cell — feasibility — that stops a plan before it spends money.
--
-- The pool is now split by spend_order so the arbitrage hierarchy Window 4
-- establishes survives to the point of use: liquidatables are drawn down
-- before any of our own stock is touched.

CREATE VIEW v_deployment_feasibility AS
WITH pool AS (
  SELECT asset_type,
         COALESCE(SUM(quantity) FILTER (WHERE spend_order = 'SPEND_FIRST'), 0)  AS first_available,
         COALESCE(SUM(quantity) FILTER (WHERE spend_order = 'SPEND_SECOND'), 0) AS second_available,
         COALESCE(SUM(quantity), 0)                                            AS total_available
  FROM v_asset_available
  GROUP BY asset_type
)
SELECT
  d.deployment_id,
  d.ward_id,
  d.deploy_date,
  d.action_type,
  d.kitted_soldiers,
  d.tshirts_drawn,

  COALESCE(r.m1_discounted, 0)                              AS ward_capacity,
  COALESCE(p.first_available, 0)                            AS pool_spend_first,
  COALESCE(p.second_available, 0)                           AS pool_spend_second,
  COALESCE(p.total_available, 0)                            AS pool_total,

  -- draw order: liquidatables first, our own stock only for the remainder
  LEAST(d.tshirts_drawn, COALESCE(p.first_available, 0))    AS draw_from_first,
  GREATEST(0, d.tshirts_drawn - COALESCE(p.first_available, 0))
                                                            AS draw_from_second,

  CASE WHEN d.kitted_soldiers <= COALESCE(r.m1_discounted, 0)
        AND d.tshirts_drawn   <= COALESCE(p.total_available, 0)
       THEN 'OK' ELSE 'SHORT' END                           AS feasibility,

  -- which constraint bites, so the plan can be fixed rather than just refused
  CASE
    WHEN d.kitted_soldiers > COALESCE(r.m1_discounted, 0)
     AND d.tshirts_drawn   > COALESCE(p.total_available, 0) THEN 'PEOPLE AND STOCK'
    WHEN d.kitted_soldiers > COALESCE(r.m1_discounted, 0)   THEN 'PEOPLE'
    WHEN d.tshirts_drawn   > COALESCE(p.total_available, 0) THEN 'STOCK'
    ELSE NULL
  END                                                       AS binding_constraint,

  d.catering_headcount * cp.catering_rate_per_head          AS catering_cost,
  d.transport_bodies   * cp.transport_rate_per_body         AS transport_cost

FROM deployment d
CROSS JOIN control_panel cp
LEFT JOIN v_ward_reliability r ON r.ward_id = d.ward_id
LEFT JOIN pool p               ON p.asset_type = 'T-shirt';
