-- Register the IEC certified candidate list as a source.
--
-- WHY THIS IS A MIGRATION AND NOT A ONE-OFF INSERT. `source_run.source_id`
-- carries a foreign key to `source`. `import-candidates.ts` wraps its work in
-- `recorded('iec_candidates', ...)`, which opens a `source_run` row before it
-- reads a single line of the CSV. Without this row the importer does not fail
-- halfway with a partial load - it fails immediately on a foreign-key
-- violation, having written nothing.
--
-- I registered this row by hand while building the importer, which made it
-- work on the development database and nowhere else. That is the same fault
-- this project has hit repeatedly: the repository had what was needed and the
-- running system did not. A row the code depends on belongs in a migration.
--
-- WHAT THE COLUMNS MEAN HERE. `stores_text = true` because candidate names
-- are stored - which is the point, and is why the `candidate` table carries a
-- CHECK against identity numbers rather than a comment asking nicely.
-- `access = 'OPEN'` because the list is published without credentials.

INSERT INTO source
  (source_id, label, kind, access, base_url, terms_url,
   stores_text, notes, enabled, measures)
VALUES
  ('iec_candidates',
   'IEC certified candidate lists',
   'OFFICIAL',
   'OPEN',
   'https://www.elections.org.za/',
   'https://www.elections.org.za/',
   true,
   'Certified ward and PR-list candidates from the IEC published PDF. Names, '
   'party, municipality and ward only - identity numbers are refused by the '
   'parser, again by the importer and again by a CHECK constraint on the '
   'candidate table. Candidates standing on a certified ballot are public '
   'figures and this is public record; it is not voter data and must never '
   'become it.',
   true,
   ARRAY['candidacy'])
ON CONFLICT (source_id) DO UPDATE SET
  label      = EXCLUDED.label,
  kind       = EXCLUDED.kind,
  access     = EXCLUDED.access,
  base_url   = EXCLUDED.base_url,
  terms_url  = EXCLUDED.terms_url,
  stores_text = EXCLUDED.stores_text,
  notes      = EXCLUDED.notes,
  measures   = EXCLUDED.measures,
  enabled    = true;
