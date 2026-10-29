-- Make the Overview's live panel actually live.
--
-- The SSE channel has existed since the dashboard was built, but only one
-- thing ever spoke on it: `NOTIFY extract_stale` after a promotion run,
-- which means "the materialised view changed, reload". Nothing announced the
-- two events that matter minute to minute on polling day - a result slip
-- being captured and a marshal filing a booth report.
--
-- Without these the Overview's pulse panel would poll, and polling on
-- election night is the wrong trade: either it is slow enough to miss the
-- thing you are watching for, or it is fast enough to hammer the database
-- during the one hour it must not be hammered.
--
-- THE PAYLOAD IS DELIBERATELY TINY. NOTIFY has an 8 kB limit and payloads
-- can arrive out of order. These carry no data at all beyond the station -
-- they are a nudge saying "something changed, ask again". The client then
-- re-reads /api/pulse, which is a single query over a view. A payload
-- carrying counts would race: two slips captured in the same second would
-- deliver two messages whose numbers disagree, and the later-arriving one
-- might be the older count.
--
-- STATEMENT-LEVEL, NOT ROW-LEVEL. A bulk capture of forty slips in one
-- insert should wake the client once, not forty times. Row-level triggers
-- here would turn a busy minute into a denial of service against the very
-- screen that needs to stay responsive.

CREATE OR REPLACE FUNCTION pulse_notify() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- TG_ARGV[0] is the channel name, passed by each trigger below so one
  -- function serves both tables.
  PERFORM pg_notify(TG_ARGV[0], '');
  RETURN NULL;  -- AFTER STATEMENT triggers ignore the return value
END;
$$;

COMMENT ON FUNCTION pulse_notify() IS
  'Wakes SSE clients after a statement touches a table the Overview pulse '
  'watches. Sends an empty payload on purpose: the client re-reads, so two '
  'notifications cannot deliver contradictory counts out of order.';

DROP TRIGGER IF EXISTS result_slip_pulse ON result_slip;
CREATE TRIGGER result_slip_pulse
  AFTER INSERT OR UPDATE OR DELETE ON result_slip
  FOR EACH STATEMENT EXECUTE FUNCTION pulse_notify('slip_captured');

/* INSERT only. booth_report is append-only - `booth_report_is_append_only()`
   rejects UPDATE with "file a new report rather than changing one" - so
   listening for UPDATE here would be listening for something the database
   refuses to let happen. */
DROP TRIGGER IF EXISTS booth_report_pulse ON booth_report;
CREATE TRIGGER booth_report_pulse
  AFTER INSERT ON booth_report
  FOR EACH STATEMENT EXECUTE FUNCTION pulse_notify('booth_reported');

/* The roster is what the staffing half of the map draws, and it is the half
   being filled in this week. Without this the map would sit stale while
   somebody assigns marshals in another tab and wonders why nothing moves. */
DROP TRIGGER IF EXISTS roster_pulse ON reporter_roster;
CREATE TRIGGER roster_pulse
  AFTER INSERT OR UPDATE OR DELETE ON reporter_roster
  FOR EACH STATEMENT EXECUTE FUNCTION pulse_notify('roster_changed');

DO $$
BEGIN
  RAISE NOTICE '051: pulse triggers installed on result_slip, booth_report, reporter_roster';
  RAISE NOTICE '051: src/api/live.ts CHANNELS must include slip_captured, booth_reported, roster_changed';
END
$$;
