-- call_log — telephone canvassing.
--
-- NOT IN SCOPE for this build. The table exists because v_ward_reliability
-- declares it as an input and because the campaign intends to use it later.
-- Nothing reads it today.
--
-- Deliberately holds no voter-level data: a count per ward per day, not a
-- record per person. Contact-level canvassing is a separate system with its
-- own data model and its own consent obligations, as the specification says.

CREATE TABLE call_log (
  call_log_id   bigserial   PRIMARY KEY,
  ward_id       text        NOT NULL REFERENCES ward (ward_id),
  call_date     date        NOT NULL,
  attempted     integer     NOT NULL DEFAULT 0 CHECK (attempted >= 0),
  reached       integer     NOT NULL DEFAULT 0 CHECK (reached >= 0),
  pledges       integer     NOT NULL DEFAULT 0 CHECK (pledges >= 0),

  created_by    text        REFERENCES app_user (user_id),
  created_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (ward_id, call_date),
  CONSTRAINT reached_not_above_attempted CHECK (reached <= attempted)
);
