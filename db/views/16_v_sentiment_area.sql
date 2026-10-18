-- WINDOW 16 — v_sentiment_area
-- Input:  issue_signal, ward, control_panel
-- Output: one row per municipality and category, over the window
--
-- The grid a heatmap reads: magnitude by area and category. Eight
-- categories is past the point where colour can carry identity, so this is
-- deliberately shaped for a single-hue sequential encoding rather than
-- eight categorical hues.

CREATE VIEW v_sentiment_area AS
SELECT
  w.municipality,
  s.category,
  COUNT(DISTINCT s.ward_id)                              AS wards,
  SUM(s.mentions)                                        AS mentions,
  ROUND(AVG(s.net_sentiment), 3)                         AS net_sentiment,
  ROUND(AVG(s.confidence), 3)                            AS confidence,
  MODE() WITHIN GROUP (ORDER BY s.tone)                  AS dominant_tone,
  COUNT(*) FILTER (WHERE s.tone = 'Mobilising')          AS mobilising_days,
  MAX(s.observed_on)                                     AS last_observed,
  MIN(s.source)                                          AS source
FROM issue_signal s
JOIN ward w USING (ward_id)
CROSS JOIN control_panel cp
WHERE s.observed_on >= CURRENT_DATE - cp.sentiment_window_days
GROUP BY w.municipality, s.category;
