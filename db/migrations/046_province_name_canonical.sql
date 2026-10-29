-- KwaZulu-Natal was two provinces.
--
-- `municipality.province_code` is correct and consistent: every KZN row
-- carries 'KZN'. `province_name` is not. 54 municipalities (921 wards) were
-- spelled 'Kwazulu-Natal' and 11 district municipalities 'KwaZulu-Natal' -
-- one letter of casing, two different provinces to anything that groups by
-- name.
--
-- WHERE THIS SHOWS. The province dropdown lists both. Filtering by one hides
-- the other. `v_issue_heat_province` reported them as separate rows, which
-- is how it was found. Anything that joins or groups on the name - a
-- report, a per-province export, a count shown to a provincial director -
-- silently splits.
--
-- The official spelling is KwaZulu-Natal, with the capital Z.
--
-- WHY A GUARD AND NOT JUST AN UPDATE. An UPDATE fixes today's rows and
-- nothing else; the next national register load can reintroduce the variant,
-- and it would be just as invisible the second time. The DO block below
-- fails the migration if any province code ever maps to more than one name
-- again, which turns a silent split into a loud stop. The repository already
-- uses this pattern in 035 for NULL regions.

UPDATE municipality
   SET province_name = 'KwaZulu-Natal'
 WHERE province_code = 'KZN'
   AND province_name <> 'KwaZulu-Natal';

-- The other eight, normalised to their official spellings in one pass so the
-- guard below is checking a known-good state rather than whatever happens to
-- be there.
UPDATE municipality SET province_name = 'Eastern Cape'  WHERE province_code = 'EC'  AND province_name <> 'Eastern Cape';
UPDATE municipality SET province_name = 'Free State'    WHERE province_code = 'FS'  AND province_name <> 'Free State';
UPDATE municipality SET province_name = 'Gauteng'       WHERE province_code = 'GT'  AND province_name <> 'Gauteng';
UPDATE municipality SET province_name = 'Limpopo'       WHERE province_code = 'LIM' AND province_name <> 'Limpopo';
UPDATE municipality SET province_name = 'Mpumalanga'    WHERE province_code = 'MP'  AND province_name <> 'Mpumalanga';
UPDATE municipality SET province_name = 'North West'    WHERE province_code = 'NW'  AND province_name <> 'North West';
UPDATE municipality SET province_name = 'Northern Cape' WHERE province_code = 'NC'  AND province_name <> 'Northern Cape';
UPDATE municipality SET province_name = 'Western Cape'  WHERE province_code = 'WC'  AND province_name <> 'Western Cape';

DO $$
DECLARE
  offenders text;
BEGIN
  SELECT string_agg(province_code || ' => ' || names, '; ')
    INTO offenders
    FROM (
      SELECT province_code, string_agg(DISTINCT province_name, ' | ') AS names
        FROM municipality
       WHERE province_code IS NOT NULL
       GROUP BY province_code
      HAVING count(DISTINCT province_name) > 1
    ) t;

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'province_code maps to more than one province_name: %. A province '
      'spelled two ways is two provinces to every GROUP BY in the system.',
      offenders;
  END IF;
END
$$;
