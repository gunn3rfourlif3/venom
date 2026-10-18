-- The source register: what Venom is allowed to read, from where, and when
-- each feed last worked.
--
-- The status column collapses enabled, access and the last run into the one
-- word the Sources screen shows. 'Closed' is deliberately distinct from
-- 'Not connected': one is a switch nobody has flipped, the other is a door
-- that is not going to open, and conflating them means someone spends a week
-- applying for Facebook access a second time.

CREATE VIEW v_source_register AS
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

  -- Only X bills per item today, but the column is general: any metered
  -- source's spend over the last 30 days, so the cost of listening is on the
  -- same screen as the listening.
  COALESCE(r.cost_usd_30d, 0) AS cost_usd_30d,

  CASE
    WHEN s.access = 'CLOSED'                           THEN 'Closed'
    WHEN NOT s.enabled                                 THEN 'Not connected'
    WHEN s.last_attempt_at IS NULL                     THEN 'Never run'
    WHEN s.last_ok_at IS NULL                          THEN 'Failing'
    WHEN s.last_attempt_at > s.last_ok_at              THEN 'Failing'
    ELSE 'Live'
  END AS status

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

COMMENT ON VIEW v_source_register IS
  'One row per source, with its access level, last outcome and metered spend. '
  'Closed means unavailable to us, not merely switched off.';
