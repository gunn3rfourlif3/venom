-- app_user — the people who may write to, or read, Venom.
--
-- Deliberately small. Venom is read-mostly: the only write surfaces are the
-- float ledger and station reporting. Everything else arrives by import.
--
-- Roles:
--   viewer    read the dashboard
--   reporter  + submit station returns
--   treasurer + submit float ledger entries
--   admin     + change control_panel, run imports
--
-- Created before station and float_ledger because both reference it.

CREATE TYPE app_role AS ENUM ('viewer', 'reporter', 'treasurer', 'admin');

CREATE TABLE app_user (
  user_id        text        PRIMARY KEY,
  email          text        NOT NULL,
  display_name   text        NOT NULL,
  role           app_role    NOT NULL DEFAULT 'viewer',
  password_hash  text        NOT NULL,
  is_active      boolean     NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_login_at  timestamptz
);

-- case-insensitive uniqueness without requiring the citext extension
CREATE UNIQUE INDEX idx_app_user_email ON app_user (lower(email));
