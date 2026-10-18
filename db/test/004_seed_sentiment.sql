-- =====================================================================
--  SYNTHETIC SENTIMENT SIGNAL. Every figure invented. Load after 003.
--
--  Stamped source = 'SYNTHETIC' on every row. No real feed exists behind
--  this yet, and nothing here may be read as what any area actually
--  thinks. Remove when a real classifier is connected:
--    DELETE FROM issue_signal WHERE source = 'SYNTHETIC';
-- =====================================================================

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM ward_issue) THEN
    RAISE EXCEPTION 'Load 003_seed_grievance_repo.sql first.';
  END IF;
END $$;

SELECT setseed(0.61);

-- Weekly signal for every ward that has a grievance, over the window.
-- Volume and sentiment both drift with severity, so the screen shows
-- something with structure rather than noise.
INSERT INTO issue_signal (
  ward_id, category, observed_on, mentions, net_sentiment, tone,
  source, source_url, confidence)
SELECT
  i.ward_id,
  i.category,
  (CURRENT_DATE - (wk * 7))::date                               AS observed_on,

  GREATEST(1, ROUND(
      (CASE i.severity WHEN 'Severe' THEN 26 WHEN 'High' THEN 15
                       WHEN 'Moderate' THEN 8 ELSE 4 END)
    * (0.55 + random() * 0.95)
    -- recent weeks carry more volume than older ones
    * (1.0 + (8 - wk) * 0.045)
  ))::int                                                        AS mentions,

  -- more severe reads more negative, with spread, clamped to the scale
  GREATEST(-1, LEAST(1, ROUND((
      (CASE i.severity WHEN 'Severe' THEN -0.72 WHEN 'High' THEN -0.52
                       WHEN 'Moderate' THEN -0.28 ELSE -0.06 END)
    + (random() - 0.5) * 0.46
    -- a resolved grievance pulls sentiment back toward neutral
    + CASE WHEN i.resolved_at IS NOT NULL THEN 0.45 ELSE 0 END
  )::numeric, 3)))                                               AS net_sentiment,

  -- disposition, not polarity: inert unhappiness and moving unhappiness
  -- are both negative and only one of them matters operationally
  (CASE
     WHEN i.severity = 'Severe' AND random() < 0.42 THEN 'Mobilising'
     WHEN i.severity IN ('Severe','High') AND random() < 0.55 THEN 'Angry'
     WHEN random() < 0.55 THEN 'Frustrated'
     ELSE 'Resigned'
   END)::sentiment_tone                                          AS tone,

  'SYNTHETIC',
  'https://example.invalid/synthetic-signal',
  ROUND((0.55 + random() * 0.4)::numeric, 3)                     AS confidence
FROM ward_issue i
CROSS JOIN generate_series(0, 7) AS wk
ON CONFLICT (ward_id, category, observed_on, source) DO NOTHING;

COMMIT;
