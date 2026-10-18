-- WINDOW 6 — v_booth_status
-- Input:  station
-- Output: coverage, density, contested status
--
-- NOBODY is the arbitrage list.
-- LOITERING is the failure mode — presence without a pledge.

CREATE VIEW v_booth_status AS
SELECT
  station_id,
  ward_id,
  name,
  registered_voters,
  our_people,
  hours_coverage,
  anc_expected,
  pledges,

  CASE WHEN hours_coverage > 0
       THEN our_people::numeric / hours_coverage
       ELSE NULL END                                        AS density,

  CASE WHEN our_people > 0 THEN 'COVERED' ELSE 'OPEN' END   AS coverage_flag,

  CASE
    WHEN our_people > 0 AND anc_expected > 0 THEN 'CONTESTED'
    WHEN our_people > 0 AND anc_expected = 0 THEN 'OURS ALONE'
    WHEN our_people = 0 AND anc_expected > 0 THEN 'THEIRS'
    ELSE 'NOBODY'
  END                                                       AS contested_flag,

  CASE WHEN our_people > 0 AND pledges = 0 THEN 'LOITERING'
       WHEN our_people > 0 AND pledges > 0 THEN 'WORKING'
       ELSE NULL END                                        AS pledge_flag

FROM station;
