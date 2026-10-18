-- WINDOW 2 — v_ward_reliability
-- Input:  ward, call_log
-- Output: reliability ratio, weekend premium, confidence-weighted capacity
--
-- m1_discounted is the number you actually plan with.
-- A zone claiming 30 who delivered 12 last time gets planned at 15, not 30.

CREATE VIEW v_ward_reliability AS
SELECT
  ward_id,
  m1_weekday,
  m2_weekend,
  m3_last_actual,

  -- claimed vs actual
  CASE WHEN m1_weekday > 0
       THEN m3_last_actual::numeric / m1_weekday
       ELSE NULL END                               AS reliability_ratio,

  -- employed vs any-day base
  CASE WHEN m1_weekday > 0
       THEN m2_weekend::numeric / m1_weekday
       ELSE NULL END                               AS weekend_premium,

  -- discount what the zone claims by what they've delivered
  ROUND(m1_weekday * LEAST(COALESCE(
    CASE WHEN m1_weekday > 0 THEN m3_last_actual::numeric / m1_weekday END,
    0.5), 1.0))                                    AS m1_discounted,

  m6_confidence
FROM ward;
