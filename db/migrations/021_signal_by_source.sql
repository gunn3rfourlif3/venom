-- Keep sources apart.
--
-- There are now two feeds in issue_signal: invented ward figures from the
-- development seed, and real municipal news coverage. Averaging them would
-- produce a number that is neither, and it would carry the seed's confident
-- precision into a reading of the real world. So every sentiment view now
-- groups by source as well, and the screen picks one.
--
-- v_sentiment_area already separated them by accident, because the two
-- feeds sit at different geo_levels. bands and trend did not.

DROP VIEW IF EXISTS v_sentiment_trend;
DROP VIEW IF EXISTS v_sentiment_bands;
DROP VIEW IF EXISTS v_sentiment_area;

CREATE VIEW v_sentiment_area AS
SELECT
  COALESCE(w.municipality, m.name)                       AS municipality,
  s.category,
  s.source,
  s.geo_level::text                                      AS geo_level,
  COUNT(DISTINCT s.ward_id)                              AS wards,
  SUM(s.mentions)                                        AS mentions,
  ROUND(AVG(s.net_sentiment), 3)                         AS net_sentiment,
  ROUND(AVG(s.confidence), 3)                            AS confidence,
  MODE() WITHIN GROUP (ORDER BY s.tone)                  AS dominant_tone,
  COUNT(*) FILTER (WHERE s.tone = 'Mobilising')          AS mobilising_days,
  MAX(s.observed_on)                                     AS last_observed
FROM issue_signal s
LEFT JOIN ward w USING (ward_id)
LEFT JOIN municipality m ON m.demarcation_code = s.demarcation_code
CROSS JOIN control_panel cp
WHERE s.observed_on >= CURRENT_DATE - cp.sentiment_window_days
  AND COALESCE(w.municipality, m.name) IS NOT NULL
GROUP BY COALESCE(w.municipality, m.name), s.category, s.source, s.geo_level;

CREATE VIEW v_sentiment_bands AS
WITH scored AS (
  SELECT
    COALESCE(w.municipality, m.name) AS municipality,
    s.source,
    s.mentions,
    CASE
      WHEN s.net_sentiment <= -cp.sentiment_strong_at THEN 'Strongly negative'
      WHEN s.net_sentiment <  -cp.sentiment_mixed_at  THEN 'Negative'
      WHEN s.net_sentiment <=  cp.sentiment_mixed_at  THEN 'Mixed'
      WHEN s.net_sentiment <   cp.sentiment_strong_at THEN 'Positive'
      ELSE 'Strongly positive'
    END AS band
  FROM issue_signal s
  LEFT JOIN ward w USING (ward_id)
  LEFT JOIN municipality m ON m.demarcation_code = s.demarcation_code
  CROSS JOIN control_panel cp
  WHERE s.observed_on >= CURRENT_DATE - cp.sentiment_window_days
    AND COALESCE(w.municipality, m.name) IS NOT NULL
)
SELECT
  municipality,
  source,
  band,
  CASE band
    WHEN 'Strongly negative' THEN 1 WHEN 'Negative' THEN 2 WHEN 'Mixed' THEN 3
    WHEN 'Positive' THEN 4 ELSE 5 END                    AS band_order,
  SUM(mentions)                                          AS mentions,
  ROUND(SUM(mentions)::numeric
        / NULLIF(SUM(SUM(mentions)) OVER (PARTITION BY municipality, source), 0), 4) AS share
FROM scored
GROUP BY municipality, source, band;

CREATE VIEW v_sentiment_trend AS
SELECT
  s.category,
  s.source,
  date_trunc('week', s.observed_on)::date                AS week_start,
  SUM(s.mentions)                                        AS mentions,
  ROUND(AVG(s.net_sentiment), 3)                         AS net_sentiment
FROM issue_signal s
CROSS JOIN control_panel cp
WHERE s.observed_on >= CURRENT_DATE - cp.sentiment_window_days
GROUP BY s.category, s.source, date_trunc('week', s.observed_on);

-- What feeds actually have signal in the window, newest first, with what
-- each one measures. The screen offers these rather than a hardcoded list,
-- so connecting a source is all it takes to appear.
CREATE VIEW v_signal_sources AS
SELECT
  s.source                                   AS source_id,
  COALESCE(src.label, s.source)              AS label,
  src.measures,
  MIN(s.geo_level)::text                     AS geo_level,
  COUNT(*)::int                              AS rows,
  SUM(s.mentions)::int                       AS mentions,
  MAX(s.observed_on)                         AS last_observed,
  (s.source = 'SYNTHETIC')                   AS synthetic
FROM issue_signal s
LEFT JOIN source src ON src.source_id = s.source
CROSS JOIN control_panel cp
WHERE s.observed_on >= CURRENT_DATE - cp.sentiment_window_days
GROUP BY s.source, src.label, src.measures
ORDER BY (s.source = 'SYNTHETIC'), SUM(s.mentions) DESC;
