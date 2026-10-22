-- Province and region, so wards can be found by where they are.
--
-- The register has had province on `ward` since the national load, but
-- nothing between province and municipality. South Africa does have that
-- level — the district municipality — and the dashboard could not filter on
-- it because the parent link was never stored.
--
-- IT IS DERIVABLE FROM THE DEMARCATION CODE, and that is checked rather than
-- assumed. A local municipality's MDB code is <province><district><local>:
--
--   GT421  Emfuleni      -> DC42  Sedibeng
--   GT481  Mogale City   -> DC48  West Rand
--   WC011  Matzikama     -> DC1   West Coast      (leading zero dropped)
--
-- Strip the alphabetic prefix, integer-divide by ten, prefix DC. Verified
-- against the register before this migration was written: **240 of 240
-- category B municipalities resolve to a district that exists, none
-- unmatched.** If a future delimitation breaks that, the CHECK at the end
-- of this file fails loudly rather than leaving wards silently unregioned.
--
-- METROS ARE THEIR OWN REGION, which is not a fudge. A category A
-- municipality is a metropolitan area — it has no district parent because it
-- is already that tier. Giving Johannesburg a region of "City of
-- Johannesburg" means every ward has a region and the filter never has a
-- hole in it, which a NULL would create for 5,070 stations.

ALTER TABLE municipality
  ADD COLUMN IF NOT EXISTS region_code text,
  ADD COLUMN IF NOT EXISTS region_name text;

-- Category B: the derived district.
UPDATE municipality m
   SET region_code = d.demarcation_code,
       region_name = d.name
  FROM municipality d
 WHERE m.category = 'B'
   AND d.category = 'C'
   AND d.demarcation_code =
       'DC' || (regexp_replace(m.demarcation_code, '^[A-Z]+', '')::int / 10)::text;

-- Category A and C: themselves. A metro is a region; a district is a region.
UPDATE municipality
   SET region_code = demarcation_code,
       region_name = name
 WHERE category IN ('A', 'C')
   AND region_code IS NULL;

CREATE INDEX IF NOT EXISTS idx_municipality_region ON municipality (region_code);
CREATE INDEX IF NOT EXISTS idx_municipality_province ON municipality (province_code);

COMMENT ON COLUMN municipality.region_code IS
  'District municipality for a category B local, derived from the MDB code '
  'and verified against the register. A metro or district is its own region, '
  'so this is never null and the region filter has no hole in it.';

-- A ward that cannot be placed in a region would quietly vanish from a
-- filtered list, which is the failure this project keeps finding: an absence
-- presented as an answer. Fail the migration instead.
DO $$
DECLARE orphans int;
BEGIN
  SELECT count(*) INTO orphans
    FROM municipality
   WHERE region_code IS NULL
     AND category IN ('A', 'B', 'C');
  IF orphans > 0 THEN
    RAISE EXCEPTION
      '% municipalities have no region. The MDB code derivation no longer '
      'holds — check for a delimitation change before shipping this.', orphans;
  END IF;
END $$;
