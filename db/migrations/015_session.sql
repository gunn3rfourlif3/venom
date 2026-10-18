-- Sessions for the API.
--
-- Server-side sessions rather than self-contained tokens: a campaign needs
-- to be able to revoke access the same hour somebody leaves, and a signed
-- token that is valid until it expires cannot be withdrawn. One table, one
-- index, and logout actually means something.
--
-- Password hashing is scrypt from node:crypto. No dependency, memory-hard,
-- and in the standard library of the runtime already in use.

CREATE TABLE session (
  session_id   text        PRIMARY KEY,          -- random 256-bit, hex
  user_id      text        NOT NULL REFERENCES app_user (user_id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  user_agent   text
);

CREATE INDEX idx_session_user    ON session (user_id);
CREATE INDEX idx_session_expiry  ON session (expires_at);

COMMENT ON TABLE session IS
  'Server-side API sessions. Delete a row to revoke access immediately.';
