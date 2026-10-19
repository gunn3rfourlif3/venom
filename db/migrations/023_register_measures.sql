-- The source register predates the `measures` column, so the Sources screen
-- could say what a feed IS but not what it TELLS YOU. That is the more
-- important half: "Google News" and "how much news coverage an issue is
-- getting, not what residents think" are a label and a warning, and only one
-- of them stops a reader over-trusting the number.
--
-- Appended at the end of the column list so CREATE OR REPLACE accepts it.

CREATE OR REPLACE VIEW v_source_register AS
SELECT
  s.source_id,
  s.label,
  s.kind::text        AS kind,
  s.access::text      AS access,
  s.enabled,
  s.stores_text,
  s.base_url,
  s.terms_url,
  s.notes,
  s.last_ok_at,
  s.last_attempt_at,
  s.last_error,

  COALESCE(r.runs, 0)     AS runs,
  COALESCE(r.failures, 0) AS failures,
  r.last_items_kept,
  COALESCE(r.cost_usd_30d, 0) AS cost_usd_30d,

  CASE
    WHEN s.access = 'CLOSED'                           THEN 'Closed'
    WHEN NOT s.enabled                                 THEN 'Not connected'
    WHEN s.last_attempt_at IS NULL                     THEN 'Never run'
    WHEN s.last_ok_at IS NULL                          THEN 'Failing'
    WHEN s.last_attempt_at > s.last_ok_at              THEN 'Failing'
    ELSE 'Live'
  END AS status,

  s.measures

FROM source s
LEFT JOIN LATERAL (
  SELECT
    count(*)                                   AS runs,
    count(*) FILTER (WHERE ok IS FALSE)        AS failures,
    sum(cost_usd) FILTER (
      WHERE started_at > now() - interval '30 days')   AS cost_usd_30d,
    (SELECT items_kept FROM source_run
      WHERE source_id = s.source_id AND ok
      ORDER BY started_at DESC LIMIT 1)        AS last_items_kept
  FROM source_run
  WHERE source_id = s.source_id
) r ON true;
