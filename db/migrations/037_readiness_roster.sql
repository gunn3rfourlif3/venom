-- Two corrections to the readiness map, and the removal of the synthetic
-- stations it exposed.
--
-- 1. THE MAP WAS READING THE WRONG COLUMN. `v_station_readiness` took
--    staffing from `station.marshal_name`, which nothing in the system
--    writes. The real marshal record is `reporter_roster` - phone, display
--    name, station_id, capture_token - which is what the WhatsApp roster
--    screen and the slip-capture tokens already use.
--
--    So "0 of 21,385 stations staffed" was true but for the wrong reason: not
--    an empty roster, a view pointed at a dead column. The roster does hold
--    people. What it does not hold is which station each is at:
--    `reporter_roster.station_id` is null on every row.
--
--    That remains a real gap - the drill on 29 October cannot attribute a
--    captured slip to a station without it - but it is now a gap with one
--    field to fill rather than a missing mechanism. See OPEN-QUESTIONS Q16.
--
-- 2. THE SYNTHETIC STATIONS GO. 2,366 development stations were sitting in
--    the register at invented coordinates, plotting as a solid rectangle over
--    Gauteng. No alert, booth report, roster entry or result slip referenced
--    any of them, so this deletes cleanly. The map already refused to count
--    them; removing them means nothing downstream has to remember to.

/* Dropped and recreated rather than CREATE OR REPLACE: the column list
   changes, which REPLACE will not allow. */
DROP VIEW IF EXISTS v_station_readiness;

DELETE FROM station WHERE source = 'SYNTHETIC';

CREATE VIEW v_station_readiness AS
SELECT
  s.station_id,
  s.ward_id,
  s.name,
  s.latitude,
  s.longitude,
  s.registered_voters,
  w.demarcation_code,
  m.name          AS municipality_name,
  m.category      AS municipality_category,
  m.province_name AS province,
  m.region_code,
  m.region_name,

  /* Kept, and now true of every row. The flag stays so that a future import
     of provisional stations cannot quietly be counted as real. */
  (s.source = 'IEC_GIS') AS is_real,

  CASE WHEN m.category = 'A' THEN 2 ELSE 3 END AS ballots_expected,

  COALESCE(s.our_people, 0) AS our_people,

  /* Staffing comes from the roster, not from the station row. An entry only
     counts if it is enabled - a disabled marshal is not coverage. */
  EXISTS (SELECT 1 FROM reporter_roster rr
           WHERE rr.station_id = s.station_id
             AND rr.enabled) AS has_marshal,

  (SELECT count(*)::int FROM reporter_roster rr
    WHERE rr.station_id = s.station_id AND rr.enabled) AS marshals,

  (SELECT count(DISTINCT r.ballot)::int
     FROM result_slip r
    WHERE r.station_id = s.station_id
      AND NOT r.superseded
      AND r.rejected IS NULL) AS ballots_captured,

  CASE
    WHEN EXISTS (SELECT 1 FROM reporter_roster rr
                  WHERE rr.station_id = s.station_id AND rr.enabled)
      THEN 'staffed'
    WHEN COALESCE(s.our_people, 0) > 0
      THEN 'people_only'
    ELSE 'unstaffed'
  END AS readiness

FROM station s
JOIN ward w         ON w.ward_id = s.ward_id
JOIN municipality m ON m.demarcation_code = w.demarcation_code;

COMMENT ON VIEW v_station_readiness IS
  'Per-station coverage for the readiness and gap maps. Staffing is read from '
  'reporter_roster (enabled entries with a station_id), which is what the '
  'roster screen and capture tokens write - station.marshal_name is written '
  'by nothing and must not be used. readiness is never null: a station with '
  'nobody on it is explicitly unstaffed.';

DO $$
DECLARE unplaceable int; synthetic int;
BEGIN
  SELECT count(*) INTO unplaceable
    FROM station WHERE latitude IS NULL OR longitude IS NULL;
  IF unplaceable > 0 THEN
    RAISE EXCEPTION
      '% stations have no coordinates and would vanish from the readiness '
      'map, quietly reducing every coverage percentage it shows.', unplaceable;
  END IF;

  SELECT count(*) INTO synthetic FROM station WHERE source <> 'IEC_GIS';
  IF synthetic > 0 THEN
    RAISE EXCEPTION
      '% stations are not from the IEC register after the cleanup. Check what '
      'imported them before trusting any coverage figure.', synthetic;
  END IF;
END $$;
