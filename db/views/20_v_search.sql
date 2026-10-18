-- One search surface over the three things worth finding: a ward, a document,
-- a decision.
--
-- A FUNCTION, NOT A VIEW, because a view cannot take the query string. The
-- point of putting it in the database at all is that ranking is then
-- comparable across kinds: three separate queries in the route would return
-- three separate relevance scales, and the route would have to invent a way
-- to interleave them, which is where a search box starts feeling arbitrary.
-- Here every row carries the same rank on the same scale and the caller sorts.
--
-- WHAT IS DELIBERATELY NOT SEARCHABLE. People. There is no person table to
-- search, grievance summaries are excluded because they are free text about
-- services and the one thing a text box invites is typing a name into it, and
-- issue_signal holds no text at all. Searching Venom cannot find you a
-- person, which is the point rather than an omission.

CREATE OR REPLACE FUNCTION search_everything(q text, lim integer DEFAULT 20)
RETURNS TABLE (
  kind     text,
  id       text,
  title    text,
  subtitle text,
  dated    date,
  rank     real
)
LANGUAGE sql
STABLE
-- Reads only; no reason for it to see anything the caller could not.
PARALLEL SAFE
AS $$
  WITH query AS (
    SELECT btrim(q) AS raw,
           CASE WHEN btrim(q) = '' THEN NULL
                ELSE websearch_to_tsquery('english', btrim(q)) END AS ts
  )

  -- Wards: matched as plain text rather than through tsvector, because ward
  -- identifiers are codes. 'GT42104012' does not stem, and someone typing
  -- "ward 12 Soweto" wants a prefix match, not a lexeme match.
  SELECT
    'ward'::text,
    w.ward_id,
    w.ward_id,
    w.municipality || COALESCE(' · ' || w.zone, ''),
    NULL::date,
    (CASE
       WHEN lower(w.ward_id) = lower(query.raw)       THEN 1.0
       WHEN w.ward_id      ILIKE query.raw || '%'     THEN 0.9
       WHEN w.ward_id      ILIKE '%' || query.raw || '%' THEN 0.6
       WHEN w.municipality ILIKE '%' || query.raw || '%' THEN 0.5
       ELSE 0.4
     END)::real
  FROM ward w, query
  WHERE query.raw <> ''
    AND (w.ward_id      ILIKE '%' || query.raw || '%'
      OR w.municipality ILIKE '%' || query.raw || '%'
      OR w.zone         ILIKE '%' || query.raw || '%')

  UNION ALL

  -- Documents: the generated tsvector from migration 014 does the work.
  SELECT
    'document'::text,
    d.document_id::text,
    d.title,
    COALESCE(d.kind::text, 'document'),
    d.document_date,
    ts_rank(d.search, query.ts)::real
  FROM document d, query
  WHERE query.ts IS NOT NULL AND d.search @@ query.ts

  UNION ALL

  -- Decisions: headline and rationale, through their own tsvector.
  SELECT
    'decision'::text,
    k.decision_id::text,
    k.headline,
    COALESCE(k.ward_id, k.municipality, k.scope::text),
    k.taken_on,
    ts_rank(k.search, query.ts)::real
  FROM decision k, query
  WHERE query.ts IS NOT NULL AND k.search @@ query.ts

  ORDER BY 6 DESC, 3
  LIMIT lim;
$$;

COMMENT ON FUNCTION search_everything(text, integer) IS
  'Search wards, documents and decisions on one rank scale. '
  'Searches no person and no grievance text.';
