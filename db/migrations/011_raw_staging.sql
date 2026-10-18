-- raw — the staging schema.
--
-- Fetchers write here and nowhere else. A separate promotion step validates
-- and upserts into the canonical tables, so a bad fetch can never leave a
-- canonical table half written.
--
-- content_hash makes fetches idempotent: a payload identical to the previous
-- one for that source and key is recorded and then ignored by promotion.

CREATE SCHEMA raw;

CREATE TABLE raw.fetch (
  fetch_id      bigserial   PRIMARY KEY,
  source        text        NOT NULL,          -- 'iec.delimitation', 'iec.results.2024', ...
  source_key    text,                          -- ward id, VD id, electoral event, ...
  source_url    text,
  payload       jsonb       NOT NULL,
  content_hash  text        NOT NULL,
  fetched_at    timestamptz NOT NULL DEFAULT now(),
  promoted_at   timestamptz,
  promote_error text
);

CREATE INDEX idx_raw_fetch_source ON raw.fetch (source, fetched_at DESC);
CREATE INDEX idx_raw_fetch_hash   ON raw.fetch (source, source_key, content_hash);
CREATE INDEX idx_raw_fetch_unpromoted
  ON raw.fetch (source, fetched_at) WHERE promoted_at IS NULL;

-- Staleness, not individual failures, is the signal worth alerting on.
-- A source that has not successfully refreshed inside its window is the
-- thing that matters; one failed fetch is noise.
CREATE VIEW v_ingest_health AS
SELECT
  source,
  max(fetched_at)                                          AS last_fetch_at,
  max(promoted_at)                                         AS last_promote_at,
  now() - max(promoted_at)                                 AS since_last_promote,
  count(*) FILTER (WHERE promote_error IS NOT NULL)        AS errors_total,
  count(*) FILTER (WHERE promoted_at IS NULL
                     AND promote_error IS NULL)            AS pending
FROM raw.fetch
GROUP BY source;
