-- WINDOW 18 — v_sentiment_trend
-- Input:  issue_signal, control_panel
-- Output: weekly mentions and average sentiment per category
--
-- Small multiples, one panel per category on a single hue — rather than
-- eight lines in eight colours on one axis, which no reader can separate
-- and no palette can make safe.

CREATE VIEW v_sentiment_trend AS
SELECT
  s.category,
  date_trunc('week', s.observed_on)::date                AS week_start,
  SUM(s.mentions)                                        AS mentions,
  ROUND(AVG(s.net_sentiment), 3)                         AS net_sentiment,
  COUNT(DISTINCT s.ward_id)                              AS wards
FROM issue_signal s
CROSS JOIN control_panel cp
WHERE s.observed_on >= CURRENT_DATE - cp.sentiment_window_days
GROUP BY s.category, date_trunc('week', s.observed_on);
