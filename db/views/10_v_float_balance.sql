-- WINDOW 10 — v_float_balance
-- Input:  float_ledger
-- Output: per zone per week, issued vs accounted vs shrinkage
--
-- Nothing more than the balance. No donor names, no receipt structure.
-- The gap is the gap.

CREATE VIEW v_float_balance AS
SELECT
  zone,
  week_ending,
  issued,
  accounted,
  issued - accounted                            AS shrinkage_actual,
  CASE WHEN issued > 0
       THEN ROUND(((issued - accounted)::numeric / issued) * 100, 2)
       ELSE NULL END                            AS shrinkage_pct,
  acknowledged_by
FROM float_ledger;
