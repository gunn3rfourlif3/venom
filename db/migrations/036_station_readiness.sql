-- Station readiness, and the gaps in it.
--
-- Two maps sit on this view: where our people are, and - more useful seven
-- days before a drill - where they are not.
--
-- THE GAP IS THE POINT. A station with nobody assigned is not a blank area on
-- a map, it is a station where the result will be whatever someone else says
-- it was. Rendering it as empty space reads as calm. Rendering it as a marked
-- absence reads as what it is. So `readiness` never returns NULL: a station
-- with nothing on it is explicitly 'unstaffed', and the map draws it.
--
-- PROVENANCE TRAVELS WITH THE POINT. 2,366 of the 23,751 stations are
-- SYNTHETIC - invented during development. A map that plots them the same as
-- the 21,385 real IEC GIS stations is a map that lies about its own coverage,
-- which is the failure this project keeps finding. `is_real` is carried
-- through to the browser and the two are drawn differently.
--
-- BALLOTS PER STATION VARY and the slip arithmetic depends on it. A category
-- A (metro) station issues two ballots - ward and municipal PR. A category B
-- (local) station issues three - ward, municipal PR, and district PR. That is
-- why the national slip count is 66,183 and not 23,751, and why a capture
-- progress bar built on station counts understates the work by nearly a
-- third.

CREATE OR REPLACE VIEW v_station_readiness AS
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

  /* Where the point came from. IEC GIS is real; SYNTHETIC is ours. */
  (s.source = 'IEC_GIS') AS is_real,

  /* Ballots this station issues, hence slips to capture off it. */
  CASE WHEN m.category = 'A' THEN 2 ELSE 3 END AS ballots_expected,

  COALESCE(s.our_people, 0) AS our_people,
  (s.marshal_name IS NOT NULL AND btrim(s.marshal_name) <> '') AS has_marshal,

  /* Slips actually in hand, ignoring superseded and rejected captures - a
     rejected slip is not coverage. */
  (SELECT count(DISTINCT r.ballot)::int
     FROM result_slip r
    WHERE r.station_id = s.station_id
      AND NOT r.superseded
      AND r.rejected IS NULL) AS ballots_captured,

  /* One word per station, never null. Ordered worst-last so the map can draw
     gaps on top rather than letting covered points hide them. */
  CASE
    WHEN s.marshal_name IS NOT NULL AND btrim(s.marshal_name) <> ''
      THEN 'staffed'
    WHEN COALESCE(s.our_people, 0) > 0
      THEN 'people_only'
    ELSE 'unstaffed'
  END AS readiness

FROM station s
JOIN ward w        ON w.ward_id = s.ward_id
JOIN municipality m ON m.demarcation_code = w.demarcation_code;

COMMENT ON VIEW v_station_readiness IS
  'Per-station coverage for the readiness and gap maps. readiness is never '
  'null - a station with nobody on it is explicitly unstaffed, because an '
  'absence drawn as blank space reads as calm. is_real distinguishes the '
  '21,385 IEC GIS stations from the 2,366 synthetic ones so the map cannot '
  'overstate its own coverage.';

/* A station that cannot be placed cannot be drawn, and would silently shrink
   the denominator of every coverage figure on the map. Fail here instead. */
DO $$
DECLARE unplaceable int;
BEGIN
  SELECT count(*) INTO unplaceable
    FROM station WHERE latitude IS NULL OR longitude IS NULL;
  IF unplaceable > 0 THEN
    RAISE EXCEPTION
      '% stations have no coordinates and would vanish from the readiness '
      'map, quietly reducing every coverage percentage it shows.', unplaceable;
  END IF;
END $$;
