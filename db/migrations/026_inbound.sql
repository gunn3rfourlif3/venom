-- Automated ingest of marshal reports over the WhatsApp Business Platform.
--
-- THE SECURITY PROBLEM AUTOMATION CREATES. A human pasting messages is also,
-- incidentally, a filter: they can see that a report is nonsense and drop it.
-- A webhook has no such judgement. The moment the reporting number is known -
-- and it will be known, because thousands of marshals have it - anyone can
-- send "10234 none none 0" and put a staffed booth on the command centre's
-- exception list on election day.
--
-- So automated ingest needs an allowlist, and that is what reporter_roster
-- is. A message from a number not on the roster is recorded and refused,
-- never filed as a report. This is the one place where knowing *who* sent
-- something is the point: it is our own people, and the alternative is a
-- system that accepts instructions from strangers.

CREATE TABLE reporter_roster (
  phone           text PRIMARY KEY,
  display_name    text NOT NULL,
  -- Optional. The template carries the booth number, so the roster does not
  -- need to know where someone is - only that they are ours.
  station_id      text REFERENCES station (station_id),
  enabled         boolean NOT NULL DEFAULT true,
  added_by        text NOT NULL,
  added_at        timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz,
  -- Same basis and the same expiry as every other contact detail we hold
  -- for our own staff. See booth_report.retention_until.
  retention_until date NOT NULL DEFAULT (CURRENT_DATE + 180),

  -- Stored E.164 so that matching is exact. '0821234567' and '+27821234567'
  -- are the same marshal and must not be two rows.
  CONSTRAINT phone_is_e164 CHECK (phone ~ '^\+[1-9][0-9]{7,14}$')
);

COMMENT ON TABLE reporter_roster IS
  'Marshals permitted to file reports by message. An allowlist: automated '
  'ingest accepts nothing from a number that is not here.';

CREATE INDEX idx_roster_enabled ON reporter_roster (enabled) WHERE enabled;

-- Every inbound message, whether it became a report or not.
--
-- Kept separately from booth_report because they answer different questions.
-- booth_report is what was reported; this is what arrived. On a day when
-- somebody claims they sent a report, the difference between those two is
-- the entire argument.
CREATE TABLE inbound_message (
  -- Meta's own message id. The primary key, because webhooks are delivered
  -- at-least-once: Meta retries on any non-200, so the same message will
  -- arrive twice and must land once.
  wamid           text PRIMARY KEY,
  received_at     timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  from_phone      text NOT NULL,
  body            text,
  -- Kept so a parser improvement can be replayed over history rather than
  -- the history being lost to the parser that existed at the time.
  outcome         text NOT NULL CHECK (outcome IN
                    ('filed', 'unknown_sender', 'unparsed', 'unknown_booth',
                     'duplicate_report', 'ignored')),
  parse_error     text,
  booth_report_id bigint REFERENCES booth_report (booth_report_id),
  retention_until date NOT NULL DEFAULT (CURRENT_DATE + 180),

  CONSTRAINT filed_has_report CHECK (
    (outcome = 'filed') = (booth_report_id IS NOT NULL))
);

CREATE INDEX idx_inbound_time    ON inbound_message (received_at DESC);
CREATE INDEX idx_inbound_outcome ON inbound_message (outcome, received_at DESC)
  WHERE outcome <> 'filed';
CREATE INDEX idx_inbound_retention ON inbound_message (retention_until);

COMMENT ON TABLE inbound_message IS
  'Every message the webhook received. The audit trail of what arrived, as '
  'distinct from booth_report, which is what was accepted.';

-- Same append-only guarantee as booth_report, and for the same reason: this
-- is the record that settles a dispute about whether a report was sent.
CREATE OR REPLACE FUNCTION inbound_message_is_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  expected inbound_message;
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.retention_until <= CURRENT_DATE
     AND NEW.from_phone = ''
     AND OLD.from_phone <> ''
  THEN
    expected := OLD;
    expected.from_phone := '';
    IF expected IS NOT DISTINCT FROM NEW THEN
      RETURN NEW;   -- retention clearing the sender, and nothing else
    END IF;
  END IF;

  RAISE EXCEPTION
    'inbound_message is append-only (attempted % on %)', TG_OP, OLD.wamid;
END $$;

CREATE TRIGGER inbound_message_no_update
  BEFORE UPDATE ON inbound_message
  FOR EACH ROW EXECUTE FUNCTION inbound_message_is_append_only();

CREATE TRIGGER inbound_message_no_delete
  BEFORE DELETE ON inbound_message
  FOR EACH ROW WHEN (OLD.retention_until > CURRENT_DATE)
  EXECUTE FUNCTION inbound_message_is_append_only();

-- What HQ needs to watch while ingest is automated: the messages that did
-- NOT become reports. An automated pipeline's failures are invisible unless
-- something puts them on a screen.
CREATE VIEW v_ingest_exceptions AS
SELECT
  m.wamid,
  m.received_at,
  m.outcome,
  m.parse_error,
  m.body,
  -- The sender is shown only as the last four digits. HQ needs to recognise
  -- a repeat offender, not to read a phone book.
  CASE WHEN m.from_phone = '' THEN '(expired)'
       ELSE '…' || right(m.from_phone, 4) END  AS from_tail,
  -- Suppressed for a refused sender. The join reflects the roster as it is
  -- NOW, so a number added after its message was refused would otherwise
  -- show a name beside 'unknown_sender' and read as a contradiction.
  CASE WHEN m.outcome = 'unknown_sender' THEN NULL
       ELSE r.display_name END                 AS known_as
FROM inbound_message m
LEFT JOIN reporter_roster r ON r.phone = m.from_phone
WHERE m.outcome <> 'filed'
  AND m.received_at > now() - interval '24 hours'
ORDER BY m.received_at DESC;

COMMENT ON VIEW v_ingest_exceptions IS
  'Messages the webhook could not file, last 24 hours. The screen that stops '
  'automated ingest from failing silently.';

-- Ingest health at a glance, for the command centre tile.
CREATE VIEW v_ingest_rate AS
SELECT
  count(*)                                                   AS messages_1h,
  count(*) FILTER (WHERE outcome = 'filed')                  AS filed_1h,
  count(*) FILTER (WHERE outcome = 'unknown_sender')         AS refused_1h,
  count(*) FILTER (WHERE outcome IN ('unparsed','unknown_booth')) AS failed_1h,
  max(received_at)                                           AS last_message_at,
  ROUND(100.0 * count(*) FILTER (WHERE outcome = 'filed')
        / NULLIF(count(*), 0), 1)                            AS filed_pct
FROM inbound_message
WHERE received_at > now() - interval '1 hour';

COMMENT ON VIEW v_ingest_rate IS
  'Last hour of automated ingest. last_message_at going quiet is itself the '
  'alert: a webhook that stops being called looks exactly like a quiet day.';

-- The staleness threshold for ingest itself, alongside every other
-- parameter rather than hardcoded.
ALTER TABLE control_panel
  ADD COLUMN IF NOT EXISTS ingest_silence_minutes integer NOT NULL DEFAULT 20
    CHECK (ingest_silence_minutes BETWEEN 5 AND 240);
