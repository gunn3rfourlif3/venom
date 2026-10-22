-- capture tokens — how a marshal uploads a photograph without an account.
--
-- Marshals are not users. They have no password, no sign-in, and on election
-- night they will be standing outside a school hall at 23:00 holding a phone.
-- Anything that asks them to remember a credential will not be used.
--
-- So each roster entry gets one long random token, and the operator sends that
-- marshal a personal link over the channel they already use. The token is the
-- credential; the roster row is the identity. Revoking is the existing
-- `enabled` flag, which already governs whether their messages are accepted,
-- so there is one switch rather than two that can disagree.
--
-- The token lives on the roster row deliberately: it then inherits
-- retention_until and is purged by the same nightly job that purges the phone
-- number. A token in a table of its own would outlive the contact detail it
-- belongs to, which is exactly the kind of quiet divergence that makes a
-- retention policy untrue.

ALTER TABLE reporter_roster
  ADD COLUMN IF NOT EXISTS capture_token text,
  ADD COLUMN IF NOT EXISTS token_issued_at timestamptz;

-- Partial, because most rows will have no token until one is issued, and two
-- NULLs must not collide.
CREATE UNIQUE INDEX IF NOT EXISTS idx_roster_capture_token
  ON reporter_roster (capture_token)
  WHERE capture_token IS NOT NULL;

-- Length is checked rather than trusted. A short token here is not a cosmetic
-- problem: it is the only thing between a stranger and the ability to file
-- photographs as a marshal.
ALTER TABLE reporter_roster
  DROP CONSTRAINT IF EXISTS capture_token_long_enough;
ALTER TABLE reporter_roster
  ADD CONSTRAINT capture_token_long_enough
  CHECK (capture_token IS NULL OR length(capture_token) >= 32);

COMMENT ON COLUMN reporter_roster.capture_token IS
  'Per-marshal upload credential. Sent as a personal link; never shown in a '
  'URL query string, so it does not land in web server logs or Referer '
  'headers. Purged with the row by the retention job.';

-- Who can upload, resolved once. The API joins this rather than the table, so
-- a disabled marshal and an expired retention date are handled in one place
-- instead of being re-checked correctly at every call site.
CREATE OR REPLACE VIEW v_capture_identity AS
SELECT capture_token,
       phone,
       display_name,
       station_id AS assigned_station
  FROM reporter_roster
 WHERE capture_token IS NOT NULL
   AND enabled
   AND retention_until >= CURRENT_DATE;

COMMENT ON VIEW v_capture_identity IS
  'Marshals who may currently upload. A token alone is not enough: the row '
  'must still be enabled and within retention.';
