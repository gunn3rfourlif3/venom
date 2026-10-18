-- WINDOW 17 — v_sentiment_bands
-- Input:  issue_signal, ward, control_panel
-- Output: share of mentions per sentiment band, per municipality
--
-- An ordered scale centred on neutral, which is the diverging stacked bar
-- case. Bands come from control_panel, not from a constant in a view.

CREATE VIEW v_sentiment_bands AS
WITH banded AS (
  SELECT
    w.municipality,
    s.mentions,
    CASE
      WHEN s.net_sentiment <= -cp.sentiment_strong_at THEN 'Strongly negative'
      WHEN s.net_sentiment <= -cp.sentiment_mixed_at  THEN 'Negative'
      WHEN s.net_sentiment <   cp.sentiment_mixed_at  THEN 'Mixed'
      WHEN s.net_sentiment <   cp.sentiment_strong_at THEN 'Positive'
      ELSE 'Strongly positive'
    END AS band
  FROM issue_signal s
  JOIN ward w USING (ward_id)
  CROSS JOIN control_panel cp
  WHERE s.observed_on >= CURRENT_DATE - cp.sentiment_window_days
)
SELECT
  municipality,
  band,
  -- the order the bar stacks in, negative arm first
  CASE band
    WHEN 'Strongly negative' THEN 1 WHEN 'Negative' THEN 2
    WHEN 'Mixed' THEN 3 WHEN 'Positive' THEN 4 ELSE 5
  END                                                        AS band_order,
  SUM(mentions)                                              AS mentions,
  ROUND(SUM(mentions)::numeric
        / NULLIF(SUM(SUM(mentions)) OVER (PARTITION BY municipality), 0), 4)
                                                             AS share
FROM banded
GROUP BY municipality, band;
