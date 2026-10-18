-- Public cameras, for the viewshed screen.
--
-- WHAT THIS IS. Installations, not footage and not people. A row is a camera
-- that a public body has already published the location of: Transport for
-- London's traffic camera feed, and OpenStreetMap's surveillance nodes. There
-- is no image, no stream URL that Venom reads, and nothing about anyone who
-- walks past one. The screen renders geometry over terrain.
--
-- WHY LONDON. Because Johannesburg has not published an equivalent feed. This
-- is a demonstration of the projection against real published data rather
-- than a map of Gauteng, and the screen says so in as many words. Camera
-- positions are not invented: if a feed is unavailable the screen is empty.
--
-- WHAT IS MEASURED AND WHAT IS NOT. Position comes from the publisher and is
-- real. Bearing is real where OSM carries camera:direction or where TfL's
-- free-text view field names a compass direction, and null otherwise - about
-- a third of the TfL feed. Field of view, range and mount height are NOT
-- published by either source. They are assumptions keyed to camera type, and
-- bearing_basis plus estimated exist so the screen can show which is which.
-- A wedge drawn from an assumed 60-degree cone is an illustration of where a
-- camera probably looks, not a claim about what it can see.

CREATE TYPE bearing_basis AS ENUM (
  'TAGGED',   -- publisher gave a direction outright (OSM camera:direction)
  'PARSED',   -- read out of free text (TfL 'East Facing')
  'UNKNOWN'); -- not published; drawn as a ring, never as a wedge

CREATE TABLE camera (
  camera_id    bigserial PRIMARY KEY,
  source_id    text      NOT NULL REFERENCES source (source_id),

  -- The publisher's own id, so a re-fetch updates rather than duplicates.
  external_id  text      NOT NULL,
  name         text,

  lat          double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lon          double precision NOT NULL CHECK (lon BETWEEN -180 AND 180),

  bearing_deg   real          CHECK (bearing_deg >= 0 AND bearing_deg < 360),
  bearing_basis bearing_basis NOT NULL DEFAULT 'UNKNOWN',

  -- Assumptions, every one of them. Nullable so that "we did not guess" is
  -- distinguishable from "we guessed zero".
  fov_deg        real CHECK (fov_deg > 0 AND fov_deg <= 360),
  range_m        real CHECK (range_m > 0),
  mount_height_m real CHECK (mount_height_m >= 0),

  camera_type  text,
  /* True while any of fov, range or height is assumed rather than published,
     which today is always. Kept as a column rather than inferred so that the
     day a source does publish them, the screen stops claiming otherwise. */
  estimated    boolean NOT NULL DEFAULT true,

  source_url   text,
  retrieved_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (source_id, external_id),

  CONSTRAINT bearing_matches_basis CHECK (
    (bearing_basis = 'UNKNOWN' AND bearing_deg IS NULL)
    OR (bearing_basis <> 'UNKNOWN' AND bearing_deg IS NOT NULL))
);

CREATE INDEX idx_camera_bbox ON camera (lat, lon);

COMMENT ON TABLE camera IS
  'Published public camera installations. Position is real; field of view, '
  'range and mount height are assumptions - see bearing_basis and estimated.';

INSERT INTO source (source_id, label, kind, access, base_url, terms_url, notes, enabled) VALUES

('tfl_jamcams', 'Transport for London traffic cameras', 'REFERENCE', 'OPEN',
 'https://api.tfl.gov.uk/Place/Type/JamCam', 'https://tfl.gov.uk/corporate/terms-and-conditions/transport-data-service',
 'Open, keyless, 890 cameras across London with position and a free-text '
 'view field. A compass bearing can be read out of that field for roughly '
 'two thirds of them; the rest have no published direction and are drawn as '
 'rings rather than wedges. Powered by TfL Open Data - attribution required.', true),

('osm_overpass', 'OpenStreetMap surveillance nodes (Overpass)', 'REFERENCE', 'OPEN',
 'https://overpass-api.de/api/interpreter', 'https://www.openstreetmap.org/copyright',
 'Richer than TfL where it has coverage: camera:direction, camera:type and '
 'camera:mount. Overpass asks that its public endpoint be left to '
 'human-operated tools, so Venom fetches once into the camera table and the '
 'browser never queries it. Data is ODbL and requires attribution.', true);
