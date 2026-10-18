-- WINDOW 2 — v_ward_reliability
-- Input:  ward, control_panel
-- Output: reliability ratio, weekend premium, planning capacity, cost per body
--
-- m1_discounted is the number you actually plan with. A zone claiming 30 who
-- delivered 12 last time gets planned at 15, not 30.
--
-- call_log is declared as an input in the original design and is still not
-- read. The table exists; telephone canvassing is deferred.

CREATE VIEW v_ward_reliability AS
SELECT
  w.ward_id,
  w.m1_weekday,
  w.m2_weekend,
  w.m3_last_actual,
  w.m4_transport_required,
  w.m5_confidence,

  -- claimed vs actual
  CASE WHEN w.m1_weekday > 0
       THEN w.m3_last_actual::numeric / w.m1_weekday
       ELSE NULL END                                 AS reliability_ratio,

  -- employed vs any-day base
  CASE WHEN w.m1_weekday > 0
       THEN w.m2_weekend::numeric / w.m1_weekday
       ELSE NULL END                                 AS weekend_premium,

  -- discount what the zone claims by what they have delivered. A zone with no
  -- deployment history gets control_panel.reliability_default.
  ROUND(w.m1_weekday * LEAST(COALESCE(
    CASE WHEN w.m1_weekday > 0 THEN w.m3_last_actual::numeric / w.m1_weekday END,
    cp.reliability_default), 1.0))                   AS m1_discounted,

  -- cost on the CLAIMED basis: understates cost wherever a zone over-claims
  CASE WHEN w.m1_weekday > 0
       THEN (w.m4_transport_required * cp.transport_rate_per_body) / w.m1_weekday
       ELSE NULL END                                 AS cost_per_body_claimed,

  -- cost on the PLANNING basis: what a body actually costs once the zone's
  -- claim is discounted by its record. This is the budgeting figure.
  CASE WHEN ROUND(w.m1_weekday * LEAST(COALESCE(
         CASE WHEN w.m1_weekday > 0 THEN w.m3_last_actual::numeric / w.m1_weekday END,
         cp.reliability_default), 1.0)) > 0
       THEN (w.m4_transport_required * cp.transport_rate_per_body)
            / ROUND(w.m1_weekday * LEAST(COALESCE(
                CASE WHEN w.m1_weekday > 0 THEN w.m3_last_actual::numeric / w.m1_weekday END,
                cp.reliability_default), 1.0))
       ELSE NULL END                                 AS cost_per_body_planned

FROM ward w
CROSS JOIN control_panel cp;
