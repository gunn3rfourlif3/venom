-- Recording which digests were actually sent out.
--
-- The chosen procedure is: seal hourly, send an anchor at 20:00, 23:00 and
-- at declaration. That works because each digest contains the previous one,
-- so the 23:00 anchor retroactively freezes every hourly seal since 20:00 -
-- three messages cover eight seals.
--
-- It creates one operational problem. At 02:00, after a long night, nobody
-- remembers which of eleven lines was the one that went to the observers'
-- group. Without that, `tally:verify --anchor` cannot be run at all, and the
-- single thing the whole scheme rests on becomes unusable at exactly the
-- moment it is needed.
--
-- So this records the act: which link was sent, when, and to whom.
--
-- WHAT THIS RECORD IS, AND EMPHATICALLY IS NOT.
--
-- It is a POINTER. It says "go and find the message you sent at 23:04 to the
-- observers' group, and compare it to link #7". It tells you which digest to
-- look for and where you said you sent it.
--
-- IT IS NOT THE ANCHOR, AND IT IS NOT EVIDENCE. The anchor is the copy in
-- somebody else's hands. Whoever can rebuild the chain can also rewrite this
-- table to agree with the rebuilt version - the row would then point at a
-- digest that was never sent, and look entirely convincing. A record of
-- publication held by the publisher proves nothing about publication.
--
-- This is the same distinction the module turns on throughout, and it is
-- worth restating because this table is the easiest place in the system to
-- mistake bookkeeping for proof. `tally:verify` therefore never treats a
-- stored anchor as verified; it names it and tells the operator to go and
-- find the real copy.

ALTER TABLE tally_commitment
  ADD COLUMN IF NOT EXISTS anchored_at timestamptz,
  ADD COLUMN IF NOT EXISTS anchored_to text;

COMMENT ON COLUMN tally_commitment.anchored_at IS
  'When this digest was reported as sent outside the campaign. A POINTER to '
  'the real anchor, which is the recipient''s copy - never evidence itself.';
COMMENT ON COLUMN tally_commitment.anchored_to IS
  'Where it was reported sent, in the operator''s own words. Free text: the '
  'point is to find the message again, not to parse it.';

ALTER TABLE tally_commitment
  ADD CONSTRAINT anchor_is_whole CHECK (
    (anchored_at IS NULL     AND anchored_to IS NULL) OR
    (anchored_at IS NOT NULL AND anchored_to IS NOT NULL));

/* The trigger gains a second permitted mutation. Written as two explicit
   cases rather than one relaxed comparison: the reveal and the anchor each
   move exactly one pair of fields, and listing them separately means a
   future edit that loosens one cannot silently loosen the other. */
CREATE OR REPLACE FUNCTION tally_commitment_no_update() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  core_unchanged boolean;
BEGIN
  core_unchanged :=
         OLD.seq            = NEW.seq
     AND OLD.scope          = NEW.scope
     AND OLD.scope_key      = NEW.scope_key
     AND OLD.taken_at       = NEW.taken_at
     AND OLD.slips_captured = NEW.slips_captured
     AND OLD.slips_expected = NEW.slips_expected
     AND OLD.prev_digest    = NEW.prev_digest
     AND OLD.digest         = NEW.digest
     AND OLD.counts         = NEW.counts
     AND OLD.nonce          = NEW.nonce
     AND OLD.committed_at   = NEW.committed_at;

  -- The reveal: revealed_at NULL -> set, anchor untouched.
  IF core_unchanged
     AND OLD.revealed_at IS NULL AND NEW.revealed_at IS NOT NULL
     AND OLD.anchored_at IS NOT DISTINCT FROM NEW.anchored_at
     AND OLD.anchored_to IS NOT DISTINCT FROM NEW.anchored_to
  THEN
    RETURN NEW;
  END IF;

  -- The anchor record: anchored_at NULL -> set, reveal untouched.
  IF core_unchanged
     AND OLD.anchored_at IS NULL AND NEW.anchored_at IS NOT NULL
     AND OLD.revealed_at IS NOT DISTINCT FROM NEW.revealed_at
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'tally_commitment is append-only: seq % cannot be updated', OLD.seq
    USING HINT = 'Two updates are permitted, each once: a reveal (sets '
                 'revealed_at) and an anchor record (sets anchored_at and '
                 'anchored_to). Everything else is immutable. To correct a '
                 'mistaken snapshot, append a new one.';
END
$$;

/* The public view. anchored_to is included: it is the operator's own note
   about where a line was sent, carries nothing sensitive by design, and
   withholding it would defeat the purpose of a record meant to be found
   again. Anyone entering a phone number or a person's details here is
   misusing the field - it wants "observers' WhatsApp group", not a contact.

   DROP then CREATE: the new columns land before links_to_previous, and
   CREATE OR REPLACE can only append (42P16, which took 036 and 037 down
   together, and 055 after them). */
DROP VIEW IF EXISTS v_commitment_chain;
CREATE VIEW v_commitment_chain AS
SELECT
  c.seq, c.scope, c.scope_key, c.taken_at,
  c.slips_captured, c.slips_expected,
  ROUND(100.0 * c.slips_captured / NULLIF(c.slips_expected, 0), 1) AS coverage_pct,
  c.prev_digest, c.digest,
  CASE WHEN c.revealed_at IS NOT NULL THEN c.counts END AS counts,
  CASE WHEN c.revealed_at IS NOT NULL THEN c.nonce  END AS nonce,
  jsonb_array_length(c.counts)                          AS parties,
  c.committed_at, c.revealed_at, c.note,
  c.anchored_at, c.anchored_to,
  (c.revealed_at IS NOT NULL)                           AS revealed,
  (c.anchored_at IS NOT NULL)                           AS anchor_recorded,
  /* Covered by a later anchor. Because each digest contains the previous
     one, an anchor at seq 7 freezes 1..7 - which is the whole reason three
     messages can cover a night of hourly seals. Computed rather than stored
     so it cannot drift from the chain it describes. */
  (c.seq <= COALESCE(
     (SELECT max(a.seq) FROM tally_commitment a WHERE a.anchored_at IS NOT NULL),
     0))                                                AS covered_by_anchor,
  (c.prev_digest = COALESCE(
     LAG(c.digest) OVER (ORDER BY c.seq), repeat('0', 64))) AS links_to_previous
FROM tally_commitment c;

COMMENT ON VIEW v_commitment_chain IS
  'Public view of the commitment chain. Counts and nonce masked until '
  'revealed. anchor_recorded is the operator''s note that a digest was sent, '
  'NOT proof that it was. links_to_previous checks linkage only; digests are '
  'recomputed by npm run tally:verify.';

/* Prove the new mutation is permitted once and the old ones stay refused. */
DO $$
DECLARE ok boolean;
BEGIN
  INSERT INTO tally_commitment
    (seq, scope, scope_key, taken_at, slips_captured, slips_expected,
     prev_digest, digest, counts, nonce, note)
  VALUES
    (-1, 'NATIONAL', '', now(), 1, 2, repeat('0', 64), repeat('a', 64),
     '[{"party":"SELFTEST","votes":1}]'::jsonb, repeat('c', 64),
     '056 self-test, removed below');

  -- Recording an anchor must be permitted.
  UPDATE tally_commitment
     SET anchored_at = now(), anchored_to = 'self-test' WHERE seq = -1;
  IF NOT EXISTS (SELECT 1 FROM v_commitment_chain
                  WHERE seq = -1 AND anchor_recorded) THEN
    RAISE EXCEPTION '056: the anchor record was not written';
  END IF;

  -- Recording it twice must not be, or a sent line could be swapped later.
  ok := false;
  BEGIN
    UPDATE tally_commitment SET anchored_to = 'somewhere else' WHERE seq = -1;
  EXCEPTION WHEN others THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION '056: an anchor record was rewritten'; END IF;

  -- The digest must still be immutable.
  ok := false;
  BEGIN
    UPDATE tally_commitment SET digest = repeat('b', 64) WHERE seq = -1;
  EXCEPTION WHEN others THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION '056: a digest was overwritten'; END IF;

  -- The reveal must still work after an anchor was recorded.
  UPDATE tally_commitment SET revealed_at = now() WHERE seq = -1;
  IF NOT EXISTS (SELECT 1 FROM v_commitment_chain WHERE seq = -1 AND revealed) THEN
    RAISE EXCEPTION '056: anchoring blocked the reveal';
  END IF;

  RAISE NOTICE '056: verified - anchor recorded once, digest still immutable';
END
$$;

ALTER TABLE tally_commitment DISABLE TRIGGER tally_commitment_no_delete;
DELETE FROM tally_commitment WHERE seq = -1;
ALTER TABLE tally_commitment ENABLE TRIGGER tally_commitment_no_delete;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM tally_commitment WHERE seq < 1) THEN
    RAISE EXCEPTION '056: self-test row survived';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'tally_commitment'::regclass
       AND tgname = 'tally_commitment_no_delete' AND tgenabled = 'O') THEN
    RAISE EXCEPTION '056: the no-delete trigger was left disabled';
  END IF;
  RAISE NOTICE '056: clean - chain empty, triggers armed';
END
$$;
