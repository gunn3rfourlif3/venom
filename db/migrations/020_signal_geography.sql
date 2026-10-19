-- Signal that is honest about where it is from.
--
-- THE PROBLEM. issue_signal requires a ward_id, because the only signal it
-- had was synthetic and synthetic data can be any shape you like. The first
-- real source is news coverage, and a report about sewage in Emfuleni is
-- about Emfuleni. It is not about ward 42100015. Spreading a municipal story
-- across that municipality's wards would manufacture ward-level precision
-- that nobody measured, which is the one thing this schema has refused to do
-- everywhere else.
--
-- So a signal row now names its own geography, and the screen can say which
-- it is looking at. A ward row and a municipality row are both real; they
-- answer different questions and are not averaged together.

CREATE TYPE geo_level AS ENUM ('WARD', 'MUNICIPALITY');

ALTER TABLE issue_signal
  ALTER COLUMN ward_id DROP NOT NULL,
  ADD COLUMN geo_level        geo_level NOT NULL DEFAULT 'WARD',
  ADD COLUMN demarcation_code text REFERENCES municipality (demarcation_code),

  -- Exactly one geography, and it must be the one the level claims.
  ADD CONSTRAINT signal_geography_matches_level CHECK (
    (geo_level = 'WARD'         AND ward_id IS NOT NULL AND demarcation_code IS NULL)
 OR (geo_level = 'MUNICIPALITY' AND ward_id IS NULL     AND demarcation_code IS NOT NULL));

-- The old key assumed a ward. Two partial keys instead, because a NULL
-- ward_id does not conflict with another NULL ward_id in a unique index and
-- the municipality rows would silently duplicate on every re-fetch.
ALTER TABLE issue_signal DROP CONSTRAINT issue_signal_ward_id_category_observed_on_source_key;

CREATE UNIQUE INDEX idx_signal_ward_key ON issue_signal
  (ward_id, category, observed_on, source) WHERE geo_level = 'WARD';
CREATE UNIQUE INDEX idx_signal_muni_key ON issue_signal
  (demarcation_code, category, observed_on, source) WHERE geo_level = 'MUNICIPALITY';

CREATE INDEX idx_signal_muni ON issue_signal (demarcation_code, observed_on DESC)
  WHERE demarcation_code IS NOT NULL;

COMMENT ON COLUMN issue_signal.geo_level IS
  'WARD for signal measured in a ward; MUNICIPALITY for signal that is only '
  'known at municipal level, such as news coverage. Never interpolated from '
  'one to the other.';

-- What a source actually measures. "Sentiment" from news headlines is not
-- what residents think - it is how much attention an issue is getting, which
-- is a real and useful thing and a different thing. The screen reads this
-- column rather than calling everything sentiment.
ALTER TABLE source
  ADD COLUMN measures text;

UPDATE source SET measures = 'invented figures, for development only'
 WHERE source_id = 'SYNTHETIC';

INSERT INTO source (source_id, label, kind, access, base_url, terms_url,
                    notes, measures, enabled) VALUES
('google_news', 'Google News (South Africa)', 'SOCIAL', 'OPEN',
 'https://news.google.com/rss/search', 'https://news.google.com',
 'Keyless RSS search, one query per municipality and issue. Returns dated, '
 'attributed headlines from South African outlets. Queried slowly and '
 'cached; only counts and scores are stored, never the headline text.',
 'how much news coverage an issue is getting in an area, not what residents think',
 true);

-- The three sentiment views are rebuilt rather than added to, because each
-- now has to read two geographies. Dropped and recreated in one migration so
-- there is never a moment where one view knows about municipalities and the
-- next does not.

DROP VIEW IF EXISTS v_sentiment_trend;
DROP VIEW IF EXISTS v_sentiment_bands;
DROP VIEW IF EXISTS v_sentiment_area;

CREATE VIEW v_sentiment_area AS
SELECT
  COALESCE(w.municipality, m.name)                       AS municipality,
  s.category,
  s.geo_level::text                                      AS geo_level,
  COUNT(DISTINCT s.ward_id)                              AS wards,
  SUM(s.mentions)                                        AS mentions,
  ROUND(AVG(s.net_sentiment), 3)                         AS net_sentiment,
  ROUND(AVG(s.confidence), 3)                            AS confidence,
  MODE() WITHIN GROUP (ORDER BY s.tone)                  AS dominant_tone,
  COUNT(*) FILTER (WHERE s.tone = 'Mobilising')          AS mobilising_days,
  MAX(s.observed_on)                                     AS last_observed,
  MIN(s.source)                                          AS source
FROM issue_signal s
LEFT JOIN ward w USING (ward_id)
LEFT JOIN municipality m ON m.demarcation_code = s.demarcation_code
CROSS JOIN control_panel cp
WHERE s.observed_on >= CURRENT_DATE - cp.sentiment_window_days
  AND COALESCE(w.municipality, m.name) IS NOT NULL
GROUP BY COALESCE(w.municipality, m.name), s.category, s.geo_level;

CREATE VIEW v_sentiment_bands AS
WITH scored AS (
  SELECT
    COALESCE(w.municipality, m.name) AS municipality,
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
  band,
  CASE band
    WHEN 'Strongly negative' THEN 1 WHEN 'Negative' THEN 2 WHEN 'Mixed' THEN 3
    WHEN 'Positive' THEN 4 ELSE 5 END                    AS band_order,
  SUM(mentions)                                          AS mentions,
  ROUND(SUM(mentions)::numeric
        / NULLIF(SUM(SUM(mentions)) OVER (PARTITION BY municipality), 0), 4) AS share
FROM scored
GROUP BY municipality, band;

CREATE VIEW v_sentiment_trend AS
SELECT
  s.category,
  date_trunc('week', s.observed_on)::date                AS week_start,
  SUM(s.mentions)                                        AS mentions,
  ROUND(AVG(s.net_sentiment), 3)                         AS net_sentiment
FROM issue_signal s
CROSS JOIN control_panel cp
WHERE s.observed_on >= CURRENT_DATE - cp.sentiment_window_days
GROUP BY s.category, date_trunc('week', s.observed_on);
