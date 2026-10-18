-- Verification fixture: three wards with known ground truth.
--
-- The specification says the verification is the work. This is it: load into
-- an empty database after all migrations and views, then check the values in
-- db/test/EXPECTED.md. Every figure there was computed by hand first.
--
--   JHB-001  not contestable (MK lost ground against 2021), candidate confirmed
--   JHB-002  contestable, NO candidate, never deployed -> Recruit / URGENT
--   JHB-003  contestable, candidate confirmed, strong delivery record -> Contest

INSERT INTO app_user (user_id, email, display_name, role, password_hash)
VALUES ('u1','t@example.com','Test Treasurer','treasurer','x');

INSERT INTO ward (ward_id, municipality, zone, registered_voters,
  t2021_anc, t2024_mkp, t2024_anc, t2024_turnout,
  peak_turnout_lge_pct, peak_turnout_all_pct, candidate_status,
  m1_weekday, m2_weekend, m3_last_actual, m4_transport_required, m5_confidence)
VALUES
 ('JHB-001','City of Johannesburg','Zone 1', 20000,
   6000, 3000, 5000, 45.00, 58.00, 66.00, 'Confirmed', 30, 18,   12, 20, 3),
 ('JHB-002','City of Johannesburg','Zone 2', 15000,
   2000, 4000, 3000, 40.00, 55.00, 62.00, 'None',      20, 10, NULL, 15, 2),
 ('JHB-003','City of Ekurhuleni','Zone 3',   25000,
   4000, 9000, 6000, 50.00, 60.00, 70.00, 'Confirmed', 40, 25,   36, 30, 5);

INSERT INTO location (location_id, kind, name, ward_id) VALUES
  ('JHB-001','ward','Ward JHB-001','JHB-001'),
  ('JHB-002','ward','Ward JHB-002','JHB-002'),
  ('JHB-003','ward','Ward JHB-003','JHB-003');

INSERT INTO asset_holding (location_id, asset_type, quantity, status) VALUES
  ('JHB-001','Door-to-door', 15,'Available'),
  ('JHB-002','Door-to-door',  2,'Available'),
  ('JHB-003','Door-to-door', 40,'Available'),
  ('CENTRAL','T-shirt',     500,'Available'),
  ('JHB-003','T-shirt',      50,'Available');

INSERT INTO liquidatable (resource_type, quantity, assessed_value, fetch_cost, strategic_destination)
VALUES ('T-shirt', 300, 9000, 500, 'CENTRAL');

INSERT INTO station (station_id, ward_id, name, registered_voters, our_people, hours_coverage, anc_expected, pledges)
VALUES ('S1','JHB-001','Station 1', 7000, 3, 6, 2, 40),
       ('S2','JHB-001','Station 2', 6000, 0, 0, 1,  0),
       ('S3','JHB-002','Station 3', 8000, 0, 0, 3,  0),
       ('S4','JHB-003','Station 4', 9000, 5, 8, 0, 75),
       ('S5','JHB-003','Station 5', 9000, 2, 4, 2,  0);

INSERT INTO deployment (ward_id, deploy_date, action_type, kitted_soldiers, tshirts_drawn, catering_headcount, transport_bodies)
VALUES ('JHB-003','2026-10-24','Door-to-door', 20, 400, 20, 30),
       ('JHB-002','2026-10-24','Door-to-door', 15,  50, 15, 10);

INSERT INTO float_ledger (zone, week_ending, issued, accounted, acknowledged_by, created_by)
VALUES ('Zone 1','2026-10-11', 10000, 8500, 'Zone 1 convener','u1');
