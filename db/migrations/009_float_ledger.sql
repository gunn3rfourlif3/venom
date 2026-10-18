-- float_ledger — cash issued against cash accounted for, per zone per week.
--
-- One of the two authenticated write surfaces. The audit columns are the
-- point of the table: an unattributed shrinkage figure is not a control.
--
-- SCOPE BOUNDARY, deliberate and unchanged: no donor-to-amount mapping, no
-- receipt structure, no named shrinkage line. This table reports issued,
-- accounted, and the gap. It is an internal control and does not discharge
-- any party funding disclosure obligation.

CREATE TABLE float_ledger (
  float_ledger_id  bigserial     PRIMARY KEY,
  zone             text          NOT NULL,
  week_ending      date          NOT NULL,
  issued           numeric(12,2) NOT NULL CHECK (issued >= 0),
  accounted        numeric(12,2) NOT NULL DEFAULT 0 CHECK (accounted >= 0),
  acknowledged_by  text          NOT NULL,

  created_by       text          NOT NULL REFERENCES app_user (user_id),
  created_at       timestamptz   NOT NULL DEFAULT now(),

  UNIQUE (zone, week_ending)
);

CREATE INDEX idx_float_ledger_week ON float_ledger (week_ending DESC);
