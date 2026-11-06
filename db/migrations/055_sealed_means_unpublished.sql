-- "Sealed" is about publication, not storage.
--
-- 053 modelled a sealed commitment as a row with NULL counts and NULL nonce,
-- filled in at reveal. That cannot work, and the CLI hit it immediately:
-- the counts have to be stored AT SEAL TIME, because the thing being
-- committed to is the tally as it stood at that instant. Recomputing it at
-- reveal would produce a different number - more slips will have arrived -
-- and a commitment you cannot open is not a commitment.
--
-- So the state is corrected here:
--
--   counts, nonce   always present, written once when the link is appended.
--   revealed_at     NULL means not yet published. This is the only field
--                   a reveal moves.
--
-- WHAT THIS HONESTLY COSTS, AND WHY IT IS STILL WORTH DOING.
--
-- A sealed tally sits readable in this database. Anyone with database access
-- can see the numbers before they are published. 053's header claimed the
-- chain view was safe to serve publicly because sealed rows held nothing;
-- that claim was wrong and is withdrawn - v_commitment_chain is rebuilt
-- below to mask counts and nonce until revealed_at is set, which makes the
-- claim true at the API boundary rather than in the storage.
--
-- But masking in a view is not secrecy, and this should not be oversold:
-- THIS SCHEME PROVES A NUMBER WAS NOT CHANGED AFTER THE FACT. It does not
-- keep that number secret from the people running the system. Making it
-- secret from your own staff too would mean computing the seal somewhere
-- they cannot reach - a different piece of work, with a key-custody problem
-- attached. Tamper-evidence is the achievable property, and it is the one
-- that actually answers the question a published running count invites.
--
-- The distinction matters for how this gets described to anyone. "Sealed"
-- here means: published as a digest, openable later, and unchangeable in
-- between. It does not mean nobody can see it.

/* The trigger first, because the ALTERs below are themselves UPDATEs of a
   sort and the old trigger's test (OLD.counts IS NULL) would refuse them. */
CREATE OR REPLACE FUNCTION tally_commitment_no_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  /* The reveal is the one permitted mutation: revealed_at NULL -> set, and
     nothing else moves. Every field is compared rather than trusting the
     caller's UPDATE list, because a trigger that checks only what it expects
     to be touched is no check at all. */
  IF OLD.revealed_at IS NULL AND NEW.revealed_at IS NOT NULL
     AND OLD.seq            = NEW.seq
     AND OLD.scope          = NEW.scope
     AND OLD.scope_key      = NEW.scope_key
     AND OLD.taken_at       = NEW.taken_at
     AND OLD.slips_captured = NEW.slips_captured
     AND OLD.slips_expected = NEW.slips_expected
     AND OLD.prev_digest    = NEW.prev_digest
     AND OLD.digest         = NEW.digest
     AND OLD.counts         = NEW.counts
     AND OLD.nonce          = NEW.nonce
     AND OLD.committed_at   = NEW.committed_at
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'tally_commitment is append-only: seq % cannot be updated', OLD.seq
    USING HINT = 'The only permitted update is a reveal, which sets '
                 'revealed_at and changes nothing else. To correct a '
                 'mistaken snapshot, append a new one - the record of the '
                 'mistake is the point of the chain.';
END
$$;

/* Now the shape. The old constraint tied all three fields together. */
ALTER TABLE tally_commitment DROP CONSTRAINT IF EXISTS reveal_is_whole;

/* Any rows from before this migration would have NULL counts and could not
   satisfy the new NOT NULLs. There are none in practice - 053's self-test
   row was removed and the CLI could never insert - but asserting it beats
   discovering it inside an ALTER. */
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM tally_commitment
   WHERE counts IS NULL OR nonce IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION
      '055: % link(s) have no counts. They were sealed under the broken '
      'model and cannot be opened - there is nothing stored to open. '
      'Resolve by hand before continuing; do not delete them silently.', n;
  END IF;
END
$$;

ALTER TABLE tally_commitment ALTER COLUMN counts SET NOT NULL;
ALTER TABLE tally_commitment ALTER COLUMN nonce  SET NOT NULL;

ALTER TABLE tally_commitment
  ADD CONSTRAINT counts_is_an_array CHECK (jsonb_typeof(counts) = 'array'),
  ADD CONSTRAINT counts_not_empty   CHECK (jsonb_array_length(counts) > 0);

COMMENT ON COLUMN tally_commitment.counts IS
  'The tally at taken_at, stored at seal time because that is what is being '
  'committed to. Masked by v_commitment_chain until revealed_at is set.';
COMMENT ON COLUMN tally_commitment.revealed_at IS
  'NULL = digest published, counts not yet. The only field a reveal moves.';

/* The public view, rebuilt to mask what is not yet published. Served to
   anyone; the masking is what makes that safe.

   DROP then CREATE, not CREATE OR REPLACE: the new `parties` column lands
   in the middle of the column list, and REPLACE can only append - it fails
   with 42P16 "cannot change name of view column". That error aborts the
   whole migration run, which is how 036 took 037 down with it. Nothing
   depends on this view yet; if something does later, it will need the
   capture-and-replay treatment from 052. */
DROP VIEW IF EXISTS v_commitment_chain;
CREATE VIEW v_commitment_chain AS
SELECT
  c.seq, c.scope, c.scope_key, c.taken_at,
  c.slips_captured, c.slips_expected,
  ROUND(100.0 * c.slips_captured / NULLIF(c.slips_expected, 0), 1) AS coverage_pct,
  c.prev_digest, c.digest,
  -- Withheld until revealed, so this view can be served publicly.
  CASE WHEN c.revealed_at IS NOT NULL THEN c.counts END AS counts,
  CASE WHEN c.revealed_at IS NOT NULL THEN c.nonce  END AS nonce,
  -- The party count is published while sealed: it leaks nothing about who
  -- got what, and without it a sealed link is an opaque hash that tells a
  -- reader nothing about whether it even covers the race they care about.
  jsonb_array_length(c.counts)                          AS parties,
  c.committed_at, c.revealed_at, c.note,
  (c.revealed_at IS NOT NULL)                           AS revealed,
  -- Linkage only. This view cannot recompute a sha256 - no pgcrypto - so it
  -- cannot confirm a digest matches its own contents. Naming it anything
  -- stronger would invite a reader to trust it for more than it does.
  (c.prev_digest = COALESCE(
     LAG(c.digest) OVER (ORDER BY c.seq), repeat('0', 64))) AS links_to_previous
FROM tally_commitment c;

COMMENT ON VIEW v_commitment_chain IS
  'Public view of the commitment chain. Counts and nonce are masked until '
  'revealed. links_to_previous checks linkage only; digests are recomputed '
  'by npm run tally:verify, not in SQL.';

/* Prove the corrected model: a seal inserts counts, a reveal moves only
   revealed_at, a second reveal fails, the digest stays immutable, and the
   view masks until revealed. */
DO $$
DECLARE
  ok boolean;
  leaked jsonb;
BEGIN
  INSERT INTO tally_commitment
    (seq, scope, scope_key, taken_at, slips_captured, slips_expected,
     prev_digest, digest, counts, nonce, note)
  VALUES
    (-1, 'NATIONAL', '', now(), 1, 2, repeat('0', 64), repeat('a', 64),
     '[{"party":"SELFTEST","votes":1}]'::jsonb, repeat('c', 64),
     '055 self-test, removed below');

  -- Sealed: the public view must not show counts or nonce.
  SELECT counts INTO leaked FROM v_commitment_chain WHERE seq = -1;
  IF leaked IS NOT NULL THEN
    RAISE EXCEPTION '055: sealed counts are visible in the public view';
  END IF;
  IF (SELECT parties FROM v_commitment_chain WHERE seq = -1) <> 1 THEN
    RAISE EXCEPTION '055: party count is not published while sealed';
  END IF;

  -- Changing a digest must fail.
  ok := false;
  BEGIN
    UPDATE tally_commitment SET digest = repeat('b', 64) WHERE seq = -1;
  EXCEPTION WHEN others THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION '055: a published digest was overwritten'; END IF;

  -- Changing counts must fail, revealed or not.
  ok := false;
  BEGIN
    UPDATE tally_commitment SET counts = '[{"party":"X","votes":9}]'::jsonb
     WHERE seq = -1;
  EXCEPTION WHEN others THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION '055: sealed counts were altered'; END IF;

  -- The reveal must be permitted.
  UPDATE tally_commitment SET revealed_at = now() WHERE seq = -1;
  SELECT counts INTO leaked FROM v_commitment_chain WHERE seq = -1;
  IF leaked IS NULL THEN
    RAISE EXCEPTION '055: counts stayed masked after a reveal';
  END IF;

  -- A second reveal must fail: no re-sealing, no reopening.
  ok := false;
  BEGIN
    UPDATE tally_commitment SET revealed_at = now() WHERE seq = -1;
  EXCEPTION WHEN others THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION '055: a link was revealed twice'; END IF;

  RAISE NOTICE '055: verified - seal stores, view masks, reveal is once and final';
END
$$;

ALTER TABLE tally_commitment DISABLE TRIGGER tally_commitment_no_delete;
DELETE FROM tally_commitment WHERE seq = -1;
ALTER TABLE tally_commitment ENABLE TRIGGER tally_commitment_no_delete;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM tally_commitment WHERE seq < 1) THEN
    RAISE EXCEPTION '055: self-test row survived';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'tally_commitment'::regclass
       AND tgname = 'tally_commitment_no_delete' AND tgenabled = 'O') THEN
    RAISE EXCEPTION '055: the no-delete trigger was left disabled';
  END IF;
  RAISE NOTICE '055: clean - chain empty, triggers armed';
END
$$;
