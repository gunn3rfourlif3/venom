-- Tamper-evident tally commitments.
--
-- WHAT THIS REPLACES. The ask was to encrypt a vote so live numbers could be
-- shown without revealing which party they belong to. That does not work:
-- the IEC posts each station's result at the station, so ground truth is
-- public within hours and any anonymous series can be joined back to it;
-- and nine unlabelled numbers from a known set of parties are identified by
-- their own magnitudes long before anyone needs a key. Hiding the label
-- cannot hide the shape, and with results the shape IS the label.
--
-- So the idea is inverted. Rather than making the numbers unreadable, this
-- makes them uncontestable: at each snapshot a digest goes out; at
-- declaration the counts and the nonce go out; anyone can recompute. The
-- question it answers is the one a published running count actually invites,
-- which is not "whose number is this" but "is this the number you held at
-- 20:15, or the number you wish you had held".
--
-- APPEND-ONLY, AND THE HONEST LIMIT OF THAT.
--
-- The triggers below reject UPDATE and DELETE on this table. That stops the
-- application, a stray migration, and anyone with ordinary write access -
-- which is most of the ways a row gets quietly edited. It does NOT stop the
-- database owner, who can drop a trigger and then do as they please. No
-- in-database mechanism can: the owner is the one enforcing it.
--
-- THIS IS NOT A GAP TO BE PATCHED IN SQL. It is why `tally:export` exists.
-- A commitment held only by the party making the claim proves nothing
-- against that party. The moment one digest is published somewhere outside
-- this database - emailed to an observer, posted, sent to a journalist -
-- every entry up to it is frozen for everyone, the owner included. The
-- chain makes tampering detectable; publishing makes it undeniable. The
-- triggers are hygiene; the export is the actual security.
--
-- WHY HASHING HAPPENS IN NODE AND NOT HERE. pgcrypto is not installed on
-- this database (checked: zero `digest` functions in pg_proc), so there is
-- no sha256 in SQL. That turns out to be the better arrangement anyway: one
-- implementation of the canonical form, in src/tally/commit.ts, which is
-- plain text and checkable by hand with sha256sum. Two implementations of a
-- serialisation is two chances to disagree about it, and a digest that
-- depends on which one you used is not a digest anyone can check.

CREATE TABLE IF NOT EXISTS tally_commitment (
  seq             integer PRIMARY KEY,
  scope           text    NOT NULL
                  CHECK (scope IN ('NATIONAL', 'PROVINCE', 'MUNICIPALITY')),
  -- Empty string, not NULL, for NATIONAL: the digest covers this field, so
  -- it needs exactly one representation of "not applicable".
  scope_key       text    NOT NULL DEFAULT '',

  -- Second precision. Millisecond drift would make the digest depend on how
  -- fast the machine was, which is not a fact about the tally.
  taken_at        timestamptz NOT NULL,

  -- Coverage is committed alongside the counts, so a digest cannot later be
  -- re-read as having covered more stations than it did.
  slips_captured  integer NOT NULL CHECK (slips_captured  >= 0),
  slips_expected  integer NOT NULL CHECK (slips_expected  >= 0),

  prev_digest     char(64) NOT NULL CHECK (prev_digest ~ '^[0-9a-f]{64}$'),
  digest          char(64) NOT NULL CHECK (digest      ~ '^[0-9a-f]{64}$'),

  -- Both NULL while sealed, both set at reveal. Never one without the other:
  -- a half-reveal is unverifiable and looks like tampering.
  counts          jsonb,
  nonce           text CHECK (nonce ~ '^[0-9a-f]{64,}$'),
  revealed_at     timestamptz,

  committed_at    timestamptz NOT NULL DEFAULT now(),
  note            text,

  CONSTRAINT reveal_is_whole CHECK (
    (counts IS NULL     AND nonce IS NULL     AND revealed_at IS NULL) OR
    (counts IS NOT NULL AND nonce IS NOT NULL AND revealed_at IS NOT NULL)
  ),
  -- NATIONAL has no key; the others are meaningless without one.
  CONSTRAINT scope_key_matches_scope CHECK (
    (scope = 'NATIONAL' AND scope_key = '') OR
    (scope <> 'NATIONAL' AND scope_key <> '')
  ),
  -- A digest that equals its predecessor means the chain did not advance.
  CONSTRAINT digest_advances CHECK (digest <> prev_digest)
);

COMMENT ON TABLE tally_commitment IS
  'Append-only hash chain over tally snapshots. Digests computed in '
  'src/tally/commit.ts (pgcrypto absent). Verify: npm run tally:verify';
COMMENT ON COLUMN tally_commitment.nonce IS
  'Random 32 bytes. Published only at reveal; without it a published digest '
  'could be confirmed against a guessed tally before declaration.';

CREATE INDEX IF NOT EXISTS tally_commitment_scope_idx
  ON tally_commitment (scope, scope_key, taken_at DESC);

/* Append-only enforcement. Two separate triggers rather than one on
   UPDATE OR DELETE, so the error message names what was actually attempted
   - at 23:00 on the 4th, "which operation" is the first thing anyone asks. */
CREATE OR REPLACE FUNCTION tally_commitment_no_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  /* The reveal is the one legitimate mutation: counts, nonce and
     revealed_at go from NULL to set, and NOTHING else may move - least of
     all the digest, which is the whole claim. */
  IF OLD.counts IS NULL AND NEW.counts IS NOT NULL
     AND OLD.digest       = NEW.digest
     AND OLD.prev_digest  = NEW.prev_digest
     AND OLD.seq          = NEW.seq
     AND OLD.scope        = NEW.scope
     AND OLD.scope_key    = NEW.scope_key
     AND OLD.taken_at     = NEW.taken_at
     AND OLD.slips_captured = NEW.slips_captured
     AND OLD.slips_expected = NEW.slips_expected
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'tally_commitment is append-only: seq % cannot be updated', OLD.seq
    USING HINT = 'The only permitted update is a reveal, which sets counts, '
                 'nonce and revealed_at and changes nothing else. To correct '
                 'a mistaken snapshot, commit a new one - the record of the '
                 'mistake is the point.';
END
$$;

CREATE OR REPLACE FUNCTION tally_commitment_no_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'tally_commitment is append-only: seq % cannot be deleted', OLD.seq
    USING HINT = 'Deleting a link breaks every digest after it, which is '
                 'exactly what the chain exists to reveal.';
END
$$;

DROP TRIGGER IF EXISTS tally_commitment_no_update ON tally_commitment;
CREATE TRIGGER tally_commitment_no_update
  BEFORE UPDATE ON tally_commitment
  FOR EACH ROW EXECUTE FUNCTION tally_commitment_no_update();

DROP TRIGGER IF EXISTS tally_commitment_no_delete ON tally_commitment;
CREATE TRIGGER tally_commitment_no_delete
  BEFORE DELETE ON tally_commitment
  FOR EACH ROW EXECUTE FUNCTION tally_commitment_no_delete();

/* The chain as anyone else sees it. Deliberately excludes nothing: a sealed
   entry's counts and nonce are NULL in the table, so there is nothing here
   to withhold, and this view is safe to serve publicly. That is the point -
   a commitment nobody can read is not a commitment. */
CREATE OR REPLACE VIEW v_commitment_chain AS
SELECT
  c.seq, c.scope, c.scope_key, c.taken_at,
  c.slips_captured, c.slips_expected,
  ROUND(100.0 * c.slips_captured / NULLIF(c.slips_expected, 0), 1) AS coverage_pct,
  c.prev_digest, c.digest, c.counts, c.nonce,
  c.committed_at, c.revealed_at, c.note,
  (c.counts IS NOT NULL)                            AS revealed,
  -- Not "valid". This view can confirm that seq N names seq N-1's digest;
  -- it cannot recompute a sha256, so it cannot confirm that a digest matches
  -- its own contents. Only `npm run tally:verify` does that, and calling
  -- this column anything stronger would invite someone to trust it for more.
  (c.prev_digest = COALESCE(
     LAG(c.digest) OVER (ORDER BY c.seq), repeat('0', 64)))  AS links_to_previous
FROM tally_commitment c;

COMMENT ON VIEW v_commitment_chain IS
  'Public view of the commitment chain. links_to_previous checks linkage '
  'only; digests are recomputed by npm run tally:verify, not in SQL.';

/* Prove the triggers fire. This project has been bitten by a unique
   constraint that could never match, which reported success for weeks while
   enforcing nothing, so a guarantee asserted in a comment is not a
   guarantee. Each attempt below must fail; if one succeeds, the migration
   does. */
DO $$
DECLARE
  d1 char(64) := repeat('a', 64);
  ok boolean;
BEGIN
  INSERT INTO tally_commitment
    (seq, scope, scope_key, taken_at, slips_captured, slips_expected,
     prev_digest, digest, note)
  VALUES
    (-1, 'NATIONAL', '', now(), 0, 0, repeat('0', 64), d1,
     'trigger self-test, removed below');

  -- UPDATE of a committed digest must be refused.
  ok := false;
  BEGIN
    UPDATE tally_commitment SET digest = repeat('b', 64) WHERE seq = -1;
  EXCEPTION WHEN others THEN ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION '053: append-only failed - a digest was overwritten';
  END IF;

  -- DELETE must be refused.
  ok := false;
  BEGIN
    DELETE FROM tally_commitment WHERE seq = -1;
  EXCEPTION WHEN others THEN ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION '053: append-only failed - a link was deleted';
  END IF;

  -- A reveal must be permitted, or the scheme cannot ever be opened.
  UPDATE tally_commitment
     SET counts = '[{"party":"TEST","votes":1}]'::jsonb,
         nonce = repeat('c', 64), revealed_at = now()
   WHERE seq = -1;
  IF NOT EXISTS (SELECT 1 FROM tally_commitment WHERE seq = -1 AND counts IS NOT NULL) THEN
    RAISE EXCEPTION '053: reveal was blocked - the chain could never be opened';
  END IF;

  -- A second reveal, which would let revealed counts be swapped, must fail.
  ok := false;
  BEGIN
    UPDATE tally_commitment
       SET counts = '[{"party":"TEST","votes":999}]'::jsonb WHERE seq = -1;
  EXCEPTION WHEN others THEN ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION '053: revealed counts could be changed after the fact';
  END IF;

  RAISE NOTICE '053: verified - updates and deletes refused, single reveal permitted';
END
$$;

/* Clear the self-test row. The triggers refuse DELETE, correctly, so they
   are stood down for exactly this statement and restored immediately. The
   self-test row has seq -1 and could be left in place, but a negative seq
   in a chain that verifies by position would be a permanent splinter in
   every later verification run. */
ALTER TABLE tally_commitment DISABLE TRIGGER tally_commitment_no_delete;
DELETE FROM tally_commitment WHERE seq = -1;
ALTER TABLE tally_commitment ENABLE TRIGGER tally_commitment_no_delete;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM tally_commitment WHERE seq < 1) THEN
    RAISE EXCEPTION '053: self-test row survived';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'tally_commitment'::regclass
       AND tgname = 'tally_commitment_no_delete'
       AND tgenabled = 'O')
  THEN
    RAISE EXCEPTION '053: the no-delete trigger was left disabled';
  END IF;
  RAISE NOTICE '053: clean - chain empty, triggers armed';
END
$$;
