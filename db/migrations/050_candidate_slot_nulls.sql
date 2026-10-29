-- Every re-import duplicated the entire candidate list.
--
-- Migration 040 declared:
--
--   CONSTRAINT candidate_slot UNIQUE
--     (demarcation_code, party, ward_id, list_order, candidate_name)
--
-- and `import-candidates.ts` relies on it, with ON CONFLICT DO NOTHING, to
-- make re-running safe. Its header says so: "Re-running is safe. The unique
-- constraint makes every row an upsert."
--
-- It does not. `ward_xor_list` guarantees that exactly one of ward_id and
-- list_order is NULL on every row, and in a UNIQUE constraint Postgres treats
-- NULLs as distinct from each other by default. Two identical candidate rows
-- therefore never conflict, ON CONFLICT never fires, and the insert proceeds.
--
-- The importer was run three times while the source registration and the
-- foreign key were being sorted out. It reported "29 285 seen, 29 285
-- written" each time and was telling the truth: it wrote all of them, every
-- time. The table reached 58,570 rows - exactly 2x - and nothing complained.
--
-- WHAT WAS AND WAS NOT AFFECTED. `v_ward_candidacy` answers with EXISTS and
-- count(DISTINCT party), so the headline figure - MK fields a ward candidate
-- in 454 of Gauteng's 526 wards - is unchanged, and has been checked rather
-- than assumed. Anything that COUNTS candidates was doubled, including the
-- Briefing's capability ladder, which reported 57,696 candidates loaded.
--
-- THE LESSON, AGAIN. A constraint that cannot fire is worse than no
-- constraint: the importer's safety came from a line of SQL nobody had
-- watched reject anything. The ID-number CHECK in the same migration was
-- tested by feeding it an identity number and confirming it threw. This one
-- was not tested by trying to insert a duplicate.

-- Deduplicate first; the constraint below cannot be created over duplicates.
DELETE FROM candidate c
 USING candidate keep
 WHERE c.candidate_id > keep.candidate_id
   AND c.demarcation_code = keep.demarcation_code
   AND c.party            = keep.party
   AND c.candidate_name   = keep.candidate_name
   AND c.ward_id    IS NOT DISTINCT FROM keep.ward_id
   AND c.list_order IS NOT DISTINCT FROM keep.list_order;

ALTER TABLE candidate DROP CONSTRAINT IF EXISTS candidate_slot;

/* NULLS NOT DISTINCT makes two NULLs equal for uniqueness, which is the
   behaviour the importer assumed it already had. Postgres 15 and later.
   With this, the ON CONFLICT target in import-candidates.ts matches and a
   re-import becomes the no-op it was always documented to be. */
ALTER TABLE candidate
  ADD CONSTRAINT candidate_slot
  UNIQUE NULLS NOT DISTINCT
  (demarcation_code, party, ward_id, list_order, candidate_name);

/* Prove it fires, in the migration, rather than trusting the declaration.
   This is the step that was missing the first time. */
DO $$
DECLARE
  sample candidate%ROWTYPE;
  before_count bigint;
  after_count  bigint;
BEGIN
  SELECT * INTO sample FROM candidate WHERE list_order IS NULL LIMIT 1;
  IF sample IS NULL THEN
    RAISE NOTICE '050: no candidates loaded, constraint not exercised';
    RETURN;
  END IF;

  SELECT count(*) INTO before_count FROM candidate;

  BEGIN
    INSERT INTO candidate
      (demarcation_code, municipality, party, ward_id, list_order,
       candidate_name, certified_on, source_url)
    VALUES (sample.demarcation_code, sample.municipality, sample.party,
            sample.ward_id, sample.list_order, sample.candidate_name,
            sample.certified_on, sample.source_url);
    RAISE EXCEPTION
      'candidate_slot did not reject an exact duplicate - the constraint is '
      'still not doing what the importer depends on';
  EXCEPTION
    WHEN unique_violation THEN
      NULL;  -- what we want
  END;

  SELECT count(*) INTO after_count FROM candidate;
  IF after_count <> before_count THEN
    RAISE EXCEPTION 'duplicate insert changed the row count: % -> %',
      before_count, after_count;
  END IF;

  RAISE NOTICE '050: candidate_slot verified - duplicate insert rejected';
END
$$;
