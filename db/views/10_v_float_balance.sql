-- WINDOW 10 — v_float_balance
-- Input:  float_ledger, app_user
-- Output: per zone per week, issued vs accounted vs shrinkage
--
-- Nothing more than the balance. No donor names, no receipt structure.
-- The gap is the gap.
--
-- created_by is carried through because an unattributed shrinkage figure is
-- a number, not a control.

CREATE VIEW v_float_balance AS
SELECT
  f.zone,
  f.week_ending,
  f.issued,
  f.accounted,
  f.issued - f.accounted                        AS shrinkage_actual,
  CASE WHEN f.issued > 0
       THEN ROUND(((f.issued - f.accounted) / f.issued) * 100, 2)
       ELSE NULL END                            AS shrinkage_pct,
  f.acknowledged_by,
  u.display_name                                AS recorded_by,
  f.created_at                                  AS recorded_at
FROM float_ledger f
LEFT JOIN app_user u ON u.user_id = f.created_by;
