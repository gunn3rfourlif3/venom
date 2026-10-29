-- 35 municipalities in this table no longer exist.
--
-- Randfontein and Westonaria became Rand West City in 2016. Baviaans,
-- Nkonkobe, Nxuba and Tsolwana were amalgamated in the same demarcation
-- round. They are still rows here, and they have been counted in every
-- per-municipality figure the system produces.
--
-- WHERE IT SHOWED. `v_issue_heat_province` reported "Eastern Cape: 48
-- municipalities, 29 with signal". Eastern Cape has not had 48 municipalities
-- since 2016. The 19 without signal were not under-collected - a number of
-- them were disestablished a decade ago, and the coverage figure beside them
-- was therefore pessimistic by construction. A denominator that includes
-- places that do not exist makes every coverage ratio in the system wrong in
-- the same direction: it always looks like less is covered than is.
--
-- THE PREDICATE. A category A (metro) or B (local) municipality with no wards
-- in the 2026 register does not exist for this election. Every live metro and
-- local council is warded - that is what makes it a council - and the
-- register is the IEC's own delimitation, which is the authority on what
-- exists. Category C (district) councils legitimately hold no wards and are
-- never touched by this.
--
-- NOT DELETED. The rows stay. Historical results, documents and decisions may
-- reference them, and deleting a municipality to fix a count is how a
-- foreign key failure gets discovered three weeks later at the worst moment.
-- They are flagged, and the views stop counting them.

ALTER TABLE municipality
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN municipality.is_active IS
  'False for a council that no longer exists for this election: category A '
  'or B with no wards in the 2026 register. Disestablished municipalities '
  'are kept as rows because history references them, and excluded from '
  'counts because including them makes every coverage ratio wrong.';

UPDATE municipality m
   SET is_active = false
 WHERE m.category IN ('A', 'B')
   AND NOT EXISTS (SELECT 1 FROM ward w
                    WHERE w.demarcation_code = m.demarcation_code);

-- District councils and anything warded are active.
UPDATE municipality m
   SET is_active = true
 WHERE m.category = 'C'
    OR EXISTS (SELECT 1 FROM ward w
                WHERE w.demarcation_code = m.demarcation_code);

DO $$
DECLARE
  n_inactive int;
  n_active   int;
BEGIN
  SELECT count(*) FILTER (WHERE NOT is_active), count(*) FILTER (WHERE is_active)
    INTO n_inactive, n_active FROM municipality;
  RAISE NOTICE '049: % municipalities marked inactive, % active', n_inactive, n_active;

  -- A warded municipality marked inactive would be a bug in the predicate
  -- above, and would silently remove a live council from every count.
  IF EXISTS (
    SELECT 1 FROM municipality m
     WHERE NOT m.is_active
       AND EXISTS (SELECT 1 FROM ward w WHERE w.demarcation_code = m.demarcation_code)
  ) THEN
    RAISE EXCEPTION 'a municipality with wards was marked inactive';
  END IF;
END
$$;


/* Province rollup, counting only councils that exist.
   Rebuilt here rather than left to db/views because this view is already in
   the database and a plain CREATE VIEW there would be skipped as a
   duplicate. */
CREATE OR REPLACE VIEW v_issue_heat_province AS
SELECT
  h.province,
  count(*)::int                                          AS municipalities,
  count(*) FILTER (WHERE h.has_signal)::int              AS municipalities_with_signal,
  SUM(h.mentions)::int                                   AS mentions,
  ROUND(AVG(h.net_sentiment) FILTER (WHERE h.has_signal), 3) AS net_sentiment,
  MAX(h.last_observed)                                   AS last_observed,
  bool_or(h.signal_basis IN ('synthetic', 'mixed'))      AS any_synthetic
FROM v_issue_heat_municipality h
JOIN municipality m ON m.demarcation_code = h.demarcation_code
WHERE m.is_active
GROUP BY h.province;

COMMENT ON VIEW v_issue_heat_province IS
  'Province rollup over councils that still exist. Disestablished '
  'municipalities are excluded: counting them made every coverage ratio '
  'read lower than it is.';
