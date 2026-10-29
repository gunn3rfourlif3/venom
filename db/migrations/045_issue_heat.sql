-- Issue heat, drillable: province -> municipality -> ward -> station.
--
-- WHAT THIS REPLACES. The viewshed screen, which rendered London camera
-- terrain and answered no question anyone asks about a South African ward.
--
-- THE CONSTRAINT THAT SHAPES EVERY COLUMN BELOW. Issue signal is thin and
-- unevenly sourced, and the two halves of it are not the same kind of fact:
--
--   geo_level = 'MUNICIPALITY'  1,984 rows, 197 municipalities, google_news
--                               - real, published, citable
--   geo_level = 'WARD'          1,920 rows, 116 wards, source 'SYNTHETIC'
--                               - development data, invented
--
-- So 116 of 4,485 wards carry any ward-level signal at all, and every one of
-- those 116 is fabricated. Meanwhile `v_sentiment_area` and
-- `v_sentiment_bands` both JOIN ward USING (ward_id), which silently drops
-- every municipality row - the real data - and aggregates only the synthetic
-- data. The social sentiment screen has been showing invented figures and
-- hiding the genuine ones.
--
-- A HEATMAP IS THE WORST POSSIBLE PLACE TO GET THIS WRONG. Colour reads as
-- measurement. A ward painted cool green because nothing was ever collected
-- there is indistinguishable, to the eye, from a ward measured and found
-- calm - and the eye is the entire interface. This is the same fault as
-- SUPPLY_OK, as NULL expected_people reading as STAFFED, and as
-- is_contestable's ELSE false, which is three times in one codebase that an
-- absence has been rendered as a finding.
--
-- Therefore every row here carries `has_signal` and `signal_basis`, and a
-- place with no signal gets NULL intensity rather than zero. Zero means
-- measured-and-quiet. NULL means nobody looked. The client must render them
-- differently and the API must not coalesce one into the other.

-- Per municipality. Reads BOTH geo levels: the municipality's own rows, plus
-- any ward rows inside it, so the real google_news signal is no longer
-- discarded by a join.
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
)
SELECT
  m.demarcation_code,
  m.name                                              AS municipality,
  m.province_name                                     AS province,
  m.category                                          AS municipality_category,
  COALESCE(SUM(sig.mentions), 0)::int                 AS mentions,
  -- NULL, not 0, when nothing was collected. The difference is the point.
  ROUND(AVG(sig.net_sentiment), 3)                    AS net_sentiment,
  ROUND(AVG(sig.confidence), 3)                       AS confidence,
  MODE() WITHIN GROUP (ORDER BY sig.tone)             AS dominant_tone,
  MAX(sig.observed_on)                                AS last_observed,
  count(DISTINCT sig.category)::int                   AS categories,
  (count(sig.*) > 0)                                  AS has_signal,
  /* Where the number came from, in the row that carries the number. A mixed
     basis is reported as mixed rather than resolved to whichever is more
     flattering. */
  CASE
    WHEN count(sig.*) = 0                                         THEN 'none'
    WHEN bool_and(sig.source = 'SYNTHETIC')                       THEN 'synthetic'
    WHEN bool_or(sig.source = 'SYNTHETIC')                        THEN 'mixed'
    ELSE 'real'
  END                                                 AS signal_basis
FROM municipality m
LEFT JOIN sig ON sig.demarcation_code = m.demarcation_code
GROUP BY m.demarcation_code, m.name, m.province_name, m.category;

COMMENT ON VIEW v_issue_heat_municipality IS
  'Issue pressure per municipality over the control-panel window, reading '
  'both municipality-level and ward-level signal. net_sentiment is NULL '
  'where nothing was collected - never 0 - and signal_basis says whether the '
  'row rests on real or synthetic data.';


-- Per ward. Ward-level signal only: a municipality figure must not be
-- smeared across its wards, which would invent a ward-level fact from a
-- municipal one and is exactly the move this file exists to prevent.
CREATE OR REPLACE VIEW v_issue_heat_ward AS
WITH win AS (SELECT sentiment_window_days AS d FROM control_panel),
sig AS (
  SELECT s.ward_id, s.category, s.mentions, s.net_sentiment, s.confidence,
         s.tone, s.observed_on, s.source
  FROM issue_signal s CROSS JOIN win
  WHERE s.geo_level = 'WARD'
    AND s.observed_on >= CURRENT_DATE - win.d
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
    WHEN count(sig.*) = 0                                         THEN 'none'
    WHEN bool_and(sig.source = 'SYNTHETIC')                       THEN 'synthetic'
    WHEN bool_or(sig.source = 'SYNTHETIC')                        THEN 'mixed'
    ELSE 'real'
  END                                                 AS signal_basis,
  (SELECT count(*)::int FROM station st WHERE st.ward_id = w.ward_id)
                                                      AS stations
FROM ward w
JOIN municipality m ON m.demarcation_code = w.demarcation_code
LEFT JOIN sig ON sig.ward_id = w.ward_id
GROUP BY w.ward_id, w.demarcation_code, m.name, m.province_name;

COMMENT ON VIEW v_issue_heat_ward IS
  'Issue pressure per ward. Ward-level signal only - a municipal figure is '
  'never divided across its wards, which would manufacture ward-level facts. '
  'Currently every ward row that has signal rests on SYNTHETIC data.';


-- Per category within a place, for the breakdown panel.
CREATE OR REPLACE VIEW v_issue_heat_category AS
WITH win AS (SELECT sentiment_window_days AS d FROM control_panel)
SELECT
  COALESCE(s.demarcation_code, w.demarcation_code)    AS demarcation_code,
  s.ward_id,
  s.geo_level::text                                   AS geo_level,
  s.category::text                                    AS category,
  SUM(s.mentions)::int                                AS mentions,
  ROUND(AVG(s.net_sentiment), 3)                      AS net_sentiment,
  MODE() WITHIN GROUP (ORDER BY s.tone)               AS dominant_tone,
  MAX(s.observed_on)                                  AS last_observed,
  bool_and(s.source = 'SYNTHETIC')                    AS synthetic
FROM issue_signal s
LEFT JOIN ward w ON w.ward_id = s.ward_id
CROSS JOIN win
WHERE s.observed_on >= CURRENT_DATE - win.d
GROUP BY 1, 2, 3, 4;

COMMENT ON VIEW v_issue_heat_category IS
  'Issue pressure split by category for one place, with a synthetic flag so '
  'a breakdown panel can mark fabricated rows individually.';


/* Province rollup. Deliberately counts PLACES WITH SIGNAL as well as
   mentions: "Gauteng: 412 mentions" invites the reading that Gauteng is
   loud, when it may mean one municipality was scraped and the rest were
   not. Coverage belongs beside magnitude or magnitude misleads. */
CREATE OR REPLACE VIEW v_issue_heat_province AS
SELECT
  province,
  count(*)::int                                       AS municipalities,
  count(*) FILTER (WHERE has_signal)::int             AS municipalities_with_signal,
  SUM(mentions)::int                                  AS mentions,
  ROUND(AVG(net_sentiment) FILTER (WHERE has_signal), 3) AS net_sentiment,
  MAX(last_observed)                                  AS last_observed,
  bool_or(signal_basis IN ('synthetic', 'mixed'))     AS any_synthetic
FROM v_issue_heat_municipality
GROUP BY province;

COMMENT ON VIEW v_issue_heat_province IS
  'Province rollup. Carries municipalities_with_signal beside mentions '
  'because a loud total and a thin sample look identical without it.';
