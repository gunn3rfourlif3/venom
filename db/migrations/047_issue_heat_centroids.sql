-- Somewhere to draw each place.
--
-- There are no ward or municipality polygons in this database - the
-- shapefiles on the Desktop are police, health, education and magisterial
-- districts, none of which is a ward boundary. What there is, is 23,696
-- voting stations with real coordinates, every one of them inside exactly
-- one ward.
--
-- So a place is drawn at the centroid of its own voting stations. That is an
-- honest construction: it is the mean position of the actual polling
-- infrastructure, which for a campaign is a more useful centre than the
-- geometric centre of a polygon anyway - it sits where the voters go rather
-- than in the middle of a dam or a game reserve.
--
-- IT IS A POINT, NOT A BOUNDARY, AND THE MAP MUST NOT PRETEND OTHERWISE.
-- A filled polygon implies a measured extent. A sized dot implies a place
-- with a magnitude attached, which is exactly what this is. `stations`
-- travels with the centroid so the client can size the dot by how much
-- infrastructure it actually represents, and so a centroid computed from one
-- station is not drawn with the same authority as one computed from ninety.

CREATE OR REPLACE VIEW v_issue_heat_municipality AS
WITH win AS (SELECT sentiment_window_days AS d FROM control_panel),
sig AS (
  SELECT
    COALESCE(s.demarcation_code, w.demarcation_code)  AS demarcation_code,
    s.category, s.mentions, s.net_sentiment, s.confidence, s.tone,
    s.observed_on, s.source
  FROM issue_signal s
  LEFT JOIN ward w ON w.ward_id = s.ward_id
  CROSS JOIN win
  WHERE s.observed_on >= CURRENT_DATE - win.d
),
geo AS (
  SELECT w.demarcation_code,
         AVG(st.latitude)  AS lat,
         AVG(st.longitude) AS lon,
         COUNT(*)::int     AS stations
  FROM station st JOIN ward w ON w.ward_id = st.ward_id
  WHERE st.latitude IS NOT NULL AND st.longitude IS NOT NULL
  GROUP BY w.demarcation_code
)
SELECT
  m.demarcation_code,
  m.name                                              AS municipality,
  m.province_name                                     AS province,
  m.category                                          AS municipality_category,
  COALESCE(SUM(sig.mentions), 0)::int                 AS mentions,
  ROUND(AVG(sig.net_sentiment), 3)                    AS net_sentiment,
  ROUND(AVG(sig.confidence), 3)                       AS confidence,
  MODE() WITHIN GROUP (ORDER BY sig.tone)             AS dominant_tone,
  MAX(sig.observed_on)                                AS last_observed,
  count(DISTINCT sig.category)::int                   AS categories,
  (count(sig.*) > 0)                                  AS has_signal,
  CASE
    WHEN count(sig.*) = 0                             THEN 'none'
    WHEN bool_and(sig.source = 'SYNTHETIC')           THEN 'synthetic'
    WHEN bool_or(sig.source = 'SYNTHETIC')            THEN 'mixed'
    ELSE 'real'
  END                                                 AS signal_basis,
  MAX(geo.lat)                                        AS lat,
  MAX(geo.lon)                                        AS lon,
  COALESCE(MAX(geo.stations), 0)                      AS stations
FROM municipality m
LEFT JOIN sig ON sig.demarcation_code = m.demarcation_code
LEFT JOIN geo ON geo.demarcation_code = m.demarcation_code
GROUP BY m.demarcation_code, m.name, m.province_name, m.category;


CREATE OR REPLACE VIEW v_issue_heat_ward AS
WITH win AS (SELECT sentiment_window_days AS d FROM control_panel),
sig AS (
  SELECT s.ward_id, s.category, s.mentions, s.net_sentiment, s.confidence,
         s.tone, s.observed_on, s.source
  FROM issue_signal s CROSS JOIN win
  WHERE s.geo_level = 'WARD'
    AND s.observed_on >= CURRENT_DATE - win.d
),
geo AS (
  SELECT ward_id,
         AVG(latitude)  AS lat,
         AVG(longitude) AS lon,
         COUNT(*)::int  AS stations
  FROM station
  WHERE latitude IS NOT NULL AND longitude IS NOT NULL
  GROUP BY ward_id
)
SELECT
  w.ward_id,
  w.demarcation_code,
  m.name                                              AS municipality,
  m.province_name                                     AS province,
  COALESCE(SUM(sig.mentions), 0)::int                 AS mentions,
  ROUND(AVG(sig.net_sentiment), 3)                    AS net_sentiment,
  ROUND(AVG(sig.confidence), 3)                       AS confidence,
  MODE() WITHIN GROUP (ORDER BY sig.tone)             AS dominant_tone,
  MAX(sig.observed_on)                                AS last_observed,
  count(DISTINCT sig.category)::int                   AS categories,
  (count(sig.*) > 0)                                  AS has_signal,
  CASE
    WHEN count(sig.*) = 0                             THEN 'none'
    WHEN bool_and(sig.source = 'SYNTHETIC')           THEN 'synthetic'
    WHEN bool_or(sig.source = 'SYNTHETIC')            THEN 'mixed'
    ELSE 'real'
  END                                                 AS signal_basis,
  COALESCE(MAX(geo.stations), 0)                      AS stations,
  MAX(geo.lat)                                        AS lat,
  MAX(geo.lon)                                        AS lon
FROM ward w
JOIN municipality m ON m.demarcation_code = w.demarcation_code
LEFT JOIN sig ON sig.ward_id = w.ward_id
LEFT JOIN geo ON geo.ward_id = w.ward_id
GROUP BY w.ward_id, w.demarcation_code, m.name, m.province_name;

CREATE INDEX IF NOT EXISTS idx_station_ward_geo
  ON station (ward_id) INCLUDE (latitude, longitude);
