-- =====================================================================
--  SYNTHETIC DEMONSTRATION DATA. NOT ELECTION RESULTS.
--
--  Every figure below is invented. No vote count, turnout percentage or
--  registration number here came from the IEC or from any real election.
--  The municipality names are real and the ward counts are approximately
--  the real 2021 figures, purely so the dataset is a realistic SIZE.
--
--  Every ward and station row is stamped source = 'SYNTHETIC'. Nothing in
--  this file may be presented, exported or screenshotted as a result,
--  forecast or projection for any actual ward.
--
--  Purpose: give the dashboard and the views something to run against
--  before IEC credentials are issued. Delete it the day real data lands:
--    DELETE FROM ward WHERE source = 'SYNTHETIC';
-- =====================================================================

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM ward WHERE source = 'iec') THEN
    RAISE EXCEPTION
      'Real IEC data is present. Refusing to mix synthetic rows into it.';
  END IF;
END $$;

-- deterministic: the same seed every run, so expected values hold
SELECT setseed(0.42);

INSERT INTO app_user (user_id, email, display_name, role, password_hash) VALUES
  ('demo-admin','admin@example.invalid','Demo Admin','admin','!disabled'),
  ('demo-treas','treasurer@example.invalid','Demo Treasurer','treasurer','!disabled'),
  ('demo-rep','reporter@example.invalid','Demo Reporter','reporter','!disabled')
ON CONFLICT (user_id) DO NOTHING;

-- Approximate 2021 ward counts per Gauteng municipality. Used for scale only.
CREATE TEMP TABLE seed_munis (code text, name text, wards int) ON COMMIT DROP;
INSERT INTO seed_munis VALUES
  ('798','City of Johannesburg',135),
  ('799','City of Tshwane',      107),
  ('797','City of Ekurhuleni',   112),
  ('421','Emfuleni',              45),
  ('422','Midvaal',               18),
  ('423','Lesedi',                13),
  ('481','Mogale City',           34),
  ('484','Merafong City',         28),
  ('485','Rand West City',        31);

CREATE TEMP TABLE seed_ward AS
SELECT
  m.code || lpad(g::text, 5, '0')                       AS ward_id,
  m.name                                                AS municipality,
  'Zone ' || chr(65 + (g % 6))                          AS zone,
  (8000 + floor(random() * 24000))::int                 AS reg,
  -- local government turnout: historically far below national
  round((29 + random() * 14)::numeric, 2)               AS lge_turnout,
  -- 2024 national turnout for the same ward: structurally higher
  round((49 + random() * 16)::numeric, 2)               AS npe_turnout,
  random()                                              AS r1,
  random()                                              AS r2,
  random()                                              AS r3,
  random()                                              AS r4
FROM seed_munis m, generate_series(1, m.wards) g;

INSERT INTO ward (
  ward_id, municipality, zone, province, registered_voters,
  t2021_anc, t2024_mkp, t2024_anc, t2024_turnout,
  peak_turnout_lge_pct, peak_turnout_all_pct, candidate_status,
  m1_weekday, m2_weekend, m3_last_actual, m4_transport_required, m5_confidence,
  source, source_fetched_at)
SELECT
  ward_id, municipality, zone, 'Gauteng', reg,
  -- 2021 ANC ward vote: a share of those who voted in a low-turnout local poll
  floor(reg * (lge_turnout / 100.0) * (0.30 + r1 * 0.25))::int,
  -- 2024: pool split between us and the rival. Gauteng is not KZN, so our
  -- share of the pool is modest and varies widely by ward.
  floor(reg * (npe_turnout / 100.0) * 0.46 * (0.10 + r2 * 0.35))::int,
  floor(reg * (npe_turnout / 100.0) * 0.46 * (0.65 - r2 * 0.30))::int,
  npe_turnout,
  lge_turnout,
  GREATEST(lge_turnout, npe_turnout),
  CASE WHEN r3 < 0.52 THEN 'Confirmed'
       WHEN r3 < 0.78 THEN 'Pending'
       ELSE 'None' END,
  (6 + floor(r4 * 34))::int,
  (3 + floor(r4 * 20))::int,
  -- some zones have never deployed: reliability must fall back to default
  CASE WHEN r1 < 0.18 THEN NULL
       ELSE floor((6 + r4 * 34) * (0.25 + r1 * 0.70))::int END,
  (4 + floor(r2 * 22))::int,
  (1 + floor(r3 * 5))::int,
  'SYNTHETIC', now()
FROM seed_ward;

INSERT INTO location (location_id, kind, name, ward_id)
SELECT ward_id, 'ward', 'Ward ' || ward_id, ward_id FROM seed_ward
ON CONFLICT (location_id) DO NOTHING;

INSERT INTO location (location_id, kind, name) VALUES
  ('DEPOT-JHB','depot','Johannesburg depot'),
  ('DEPOT-PTA','depot','Tshwane depot')
ON CONFLICT (location_id) DO NOTHING;

-- 4 to 9 voting stations per ward
CREATE TEMP TABLE seed_station AS
SELECT
  w.ward_id,
  w.ward_id || '-' || lpad(s::text, 2, '0')     AS station_id,
  s,
  random()                                      AS r1,
  random()                                      AS r2,
  random()                                      AS r3
FROM seed_ward w, generate_series(1, 4 + (abs(hashtext(w.ward_id)) % 6)) s;

INSERT INTO station (
  station_id, ward_id, name, registered_voters,
  latitude, longitude, our_people, hours_coverage, anc_expected, pledges,
  source, source_fetched_at, reported_by, reported_at)
SELECT
  st.station_id, st.ward_id,
  'Voting Station ' || st.s || ', Ward ' || st.ward_id,
  floor(w.reg / (4 + (abs(hashtext(w.ward_id)) % 6)))::int,
  round((-25.6 - st.r1 * 1.3)::numeric, 6),
  round(( 27.7 + st.r2 * 1.1)::numeric, 6),
  CASE WHEN st.r1 < 0.42 THEN 0 ELSE (1 + floor(st.r2 * 5))::int END,
  CASE WHEN st.r1 < 0.42 THEN 0 ELSE round((2 + st.r3 * 8)::numeric, 2) END,
  CASE WHEN st.r3 < 0.72 THEN (1 + floor(st.r3 * 4))::int ELSE 0 END,
  -- presence without pledges is the LOITERING case the view exists to flag
  CASE WHEN st.r1 >= 0.42 AND st.r2 > 0.22
       THEN floor(st.r2 * 90)::int ELSE 0 END,
  'SYNTHETIC', now(),
  CASE WHEN st.r1 >= 0.42 THEN 'demo-rep' ELSE NULL END,
  CASE WHEN st.r1 >= 0.42 THEN now() ELSE NULL END
FROM seed_station st
JOIN seed_ward w USING (ward_id);

-- door-to-door capacity held per ward, kit held centrally
INSERT INTO asset_holding (location_id, asset_type, quantity, status)
SELECT ward_id, 'Door-to-door', floor(random() * 26)::int, 'Available' FROM seed_ward
ON CONFLICT (location_id, asset_type, status) DO NOTHING;

INSERT INTO asset_holding (location_id, asset_type, quantity, status) VALUES
  ('CENTRAL','T-shirt',   14000,'Available'),
  ('CENTRAL','Poster',     9000,'Available'),
  ('DEPOT-JHB','T-shirt',  3500,'Available'),
  ('DEPOT-PTA','T-shirt',  2800,'Available')
ON CONFLICT (location_id, asset_type, status) DO NOTHING;

INSERT INTO liquidatable (resource_type, quantity, assessed_value, fetch_cost, strategic_destination, status) VALUES
  ('T-shirt', 6200, 186000, 12000,'CENTRAL','Available'),
  ('Poster',  4000,  40000,  3500,'CENTRAL','Available'),
  -- not worth fetching: v_asset_available must exclude this one
  ('Banner',   300,   9000, 11000,'DEPOT-JHB','Available');

INSERT INTO deployment (ward_id, deploy_date, action_type, kitted_soldiers,
                        tshirts_drawn, catering_headcount, transport_bodies)
SELECT ward_id, DATE '2026-10-24' + ((abs(hashtext(ward_id)) % 3) * 7),
       'Door-to-door',
       (8 + floor(random() * 30))::int,
       (40 + floor(random() * 260))::int,
       (8 + floor(random() * 26))::int,
       (5 + floor(random() * 24))::int
FROM seed_ward
WHERE random() < 0.22;

INSERT INTO float_ledger (zone, week_ending, issued, accounted, acknowledged_by, created_by)
SELECT z.zone, wk.week_ending,
       round((18000 + random() * 42000)::numeric, 2),
       round(((18000 + random() * 42000) * (0.74 + random() * 0.26))::numeric, 2),
       z.zone || ' convener', 'demo-treas'
FROM (SELECT DISTINCT zone FROM seed_ward) z,
     (VALUES (DATE '2026-09-27'), (DATE '2026-10-04'),
             (DATE '2026-10-11'), (DATE '2026-10-18')) AS wk(week_ending)
ON CONFLICT (zone, week_ending) DO NOTHING;

COMMIT;

REFRESH MATERIALIZED VIEW mv_campaign_extract;
