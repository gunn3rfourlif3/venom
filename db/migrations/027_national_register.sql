-- National ward and voting-station register.
--
-- Until now the scope was Gauteng and 523 wards carried invented numbers. The
-- register loads 4,488 wards and ~23,699 voting stations from the IEC's GIS
-- API, which turns out to be open and to accept MDB demarcation codes
-- directly - so municipalmoney.gov.za supplies the municipality list and the
-- IEC supplies the geography beneath it.

-- WHY registered_voters BECOMES NULLABLE, which is the important change here.
--
-- The GIS API serves geography, not the voters' roll: it has no registered
-- voter count. The column is NOT NULL with no default, so loading a national
-- ward would have forced a number to be invented - and 0 is not a missing
-- value, it is a claim. A ward with 0 registered voters propagates into every
-- computed view as a division by zero or a turnout of infinity, and the
-- resulting figure looks like data.
--
-- NULL is the honest encoding of "the roll has not been loaded for this
-- ward", and it propagates to NULL rather than to a plausible lie.
ALTER TABLE ward ALTER COLUMN registered_voters DROP NOT NULL;

COMMENT ON COLUMN ward.registered_voters IS
  'From the voters roll, not from the GIS register. NULL means not yet '
  'loaded for this ward - never treat it as zero. See roll_source for where '
  'a present value came from.';

-- PROVENANCE PER CONCERN, NOT PER ROW.
--
-- ward.source was one column describing where the row came from, which
-- worked while a row had one origin. It no longer does: loading the national
-- register refreshes a ward's *geography* from the IEC while its
-- registered_voters may still be a synthetic figure from the Gauteng demo
-- set. One column cannot honestly say "geography from the IEC, voter count
-- invented", and the ward-size heatmap divides by that count - so a chart
-- built on synthetic numbers would look exactly as convincing as a real one.
--
-- So: source now means the geography, and roll_source means the voter count.
ALTER TABLE ward
  ADD COLUMN IF NOT EXISTS roll_source text;

COMMENT ON COLUMN ward.source IS
  'Where this ward''s GEOGRAPHY came from - IEC_GIS for the real register.';
COMMENT ON COLUMN ward.roll_source IS
  'Where registered_voters came from. SYNTHETIC means invented for the demo '
  'and must never reach a published figure. NULL alongside a NULL count '
  'means the roll has simply not been loaded.';

UPDATE ward SET roll_source = 'SYNTHETIC'
 WHERE registered_voters IS NOT NULL
   AND roll_source IS NULL
   AND source = 'SYNTHETIC';

-- The proper join to municipality. ward.municipality holds a display name
-- ("City of Johannesburg"), which is fine to read and wrong to join on:
-- names are not stable, are not unique across provinces, and the IEC and
-- municipalmoney spell some of them differently. The demarcation code is the
-- key both sources agree on.
ALTER TABLE ward
  ADD COLUMN IF NOT EXISTS demarcation_code text REFERENCES municipality (demarcation_code),
  -- The number a councillor and a voter actually use. ward_id is 79800001;
  -- the ward is "Ward 1".
  ADD COLUMN IF NOT EXISTS ward_no integer,
  -- The delimitation this ward belongs to. See GOTCHAS.md G2: ward 42 in
  -- 2016 is not ward 42 in 2021, and a cross-year comparison without this
  -- column produces a number that looks exactly like a trend.
  --
  -- NULLABLE, WITH NO DEFAULT, and that is the whole point. A default of
  -- '2026' would have stamped every ward already in this table as 2026 - and
  -- the rows already here are the synthetic Gauteng set, whose ward ids are
  -- a different vintage: the 2026 delimitation gives Gauteng 526 wards and
  -- the existing set has 523 with ids that only partly overlap. Defaulting
  -- would have asserted a vintage for rows nobody checked, which is exactly
  -- the silent-wrong-number failure this column exists to prevent.
  --
  -- So: the loader writes '2026' for what it fetches, and anything already
  -- here keeps NULL until someone establishes which delimitation it came
  -- from. NULL means unknown, and unknown is the truth.
  ADD COLUMN IF NOT EXISTS delimitation text;

CREATE INDEX IF NOT EXISTS idx_ward_demarcation ON ward (demarcation_code);
CREATE INDEX IF NOT EXISTS idx_ward_delimitation ON ward (delimitation);

COMMENT ON COLUMN ward.delimitation IS
  'Which delimitation drew this ward. Boundaries are redrawn before every '
  'municipal election, so results from different vintages are not '
  'comparable without an explicit crosswalk.';

-- Operational detail for the station. A marshal who cannot find the building
-- is not at the station, and "THE VICTORIOUS RESTORATION CHURCH
-- INTERNATIONAL" is easier to find with a suburb attached.
ALTER TABLE station
  ADD COLUMN IF NOT EXISTS street_name  text,
  ADD COLUMN IF NOT EXISTS suburb       text,
  ADD COLUMN IF NOT EXISTS town         text,
  -- PERMANENT (P) / TEMPORARY (T). A temporary station is a tent, which
  -- matters for both weather and for finding it.
  ADD COLUMN IF NOT EXISTS station_type text;

COMMENT ON COLUMN station.station_id IS
  'The IEC voting district number. The natural key: it is what a result slip '
  'carries and what a marshal reads off the wall.';

-- Which places are loaded, and from where. The national load is a long walk
-- over an external API and will be interrupted; this is what makes it
-- resumable and what answers "is the register complete?".
CREATE VIEW v_register_coverage AS
SELECT
  w.province,
  count(DISTINCT w.demarcation_code)                      AS municipalities,
  count(DISTINCT w.ward_id)                               AS wards,
  count(DISTINCT s.station_id)                            AS stations,
  count(DISTINCT w.ward_id) FILTER (WHERE s.station_id IS NULL) AS wards_without_stations,
  -- Split deliberately. "wards with a voter count" would be a comforting
  -- number that includes invented ones.
  count(DISTINCT w.ward_id) FILTER (
    WHERE w.registered_voters IS NOT NULL
      AND w.roll_source IS DISTINCT FROM 'SYNTHETIC')      AS wards_with_real_roll,
  count(DISTINCT w.ward_id) FILTER (
    WHERE w.roll_source = 'SYNTHETIC')                     AS wards_with_synthetic_roll,
  count(DISTINCT w.ward_id) FILTER (WHERE w.delimitation = '2026') AS wards_2026,
  -- Wards of unknown vintage. Not a rounding error: a ward here is one whose
  -- boundary nobody has established, so any figure computed from it across
  -- years is unsafe. This number should be zero before any multi-cycle claim
  -- is made from this database.
  count(DISTINCT w.ward_id) FILTER (WHERE w.delimitation IS NULL) AS wards_unknown_vintage
FROM ward w
LEFT JOIN station s ON s.ward_id = w.ward_id
GROUP BY w.province
ORDER BY w.province;

COMMENT ON VIEW v_register_coverage IS
  'Register completeness by province. wards_without_stations is the resume '
  'list for the loader; wards_unknown_vintage is the list that must be '
  'cleared before comparing anything across elections.';

-- The IEC's GIS API as a source in its own right, so the register appears on
-- the source register screen alongside everything else and a failed load is
-- visible rather than silent.
--
-- OPEN, and worth noting why that is remarkable: the IEC's *results* API
-- needs credentials we are still waiting on, which has blocked every real
-- election figure in this system. The GIS service needs none. So the national
-- geography can be built now, and the results can follow when the keys do.
INSERT INTO source (source_id, label, kind, access, base_url, terms_url,
                    stores_text, notes, measures, enabled) VALUES
('iec_gis', 'IEC GIS register', 'OFFICIAL', 'OPEN',
 'https://api.elections.org.za/IECGIS/api',
 'https://api.elections.org.za/IECGIS/Help',
 false,
 'Open geographic register: municipalities, wards, voting districts and the '
 'voting station in each. Accepts MDB demarcation codes directly, which is '
 'the same key municipalmoney.gov.za uses, so the two join without a '
 'translation table. Serves no voters roll, so a ward loaded from here has '
 'registered_voters NULL until the roll is loaded from elsewhere. The '
 'coordinate-based endpoints currently throw server-side; only the id-based '
 'ones are used.',
 'where every ward and voting station is, and what the station is called',
 true)
ON CONFLICT (source_id) DO UPDATE
  SET label = EXCLUDED.label, notes = EXCLUDED.notes,
      measures = EXCLUDED.measures, enabled = EXCLUDED.enabled;
