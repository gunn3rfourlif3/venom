-- WINDOW 12 — v_ward_target
-- Input:  v_ward_computed, v_ward_pressure, v_priority_rank
-- Output: contestability crossed with live pressure
--
-- This is the thing neither signal gives alone. The electoral arithmetic
-- says a ward is contestable; it cannot say the ward has been without water
-- for nine days. A contestable ward under live pressure is a real target. A
-- contestable ward that is quiet may not move at all.
--
-- PRESSURE ONLY is the row worth reading twice: wards the arithmetic writes
-- off where something is nonetheless happening. The 2021 and 2024 results
-- cannot see a grievance that started last month.
--
-- FIRST CYCLE THIS IS DESCRIPTIVE, NOT PREDICTIVE. There is no baseline
-- yet, so "elevated" has no historical meaning. It earns its forecasting
-- keep next cycle, scored against the calibration residual.

CREATE VIEW v_ward_target AS
SELECT
  c.ward_id,
  c.municipality,
  c.zone,
  c.is_contestable,
  c.rival_decline_share,
  p.pressure_band,
  p.pressure_index,
  p.open_issues,
  p.serious_issues,
  p.unplanned_outages,
  r.recommended_box,
  r.priority_rank,
  r.gap_flag,

  CASE
    WHEN c.is_contestable AND p.pressure_band IN ('HIGH','ELEVATED') THEN 'ACT NOW'
    WHEN c.is_contestable                                           THEN 'WATCH'
    WHEN p.pressure_band = 'HIGH'                                   THEN 'PRESSURE ONLY'
    ELSE 'QUIET'
  END                                                               AS target_class,

  -- one line of reading, so the classification explains itself on screen
  CASE
    WHEN c.is_contestable AND p.pressure_band IN ('HIGH','ELEVATED')
      THEN 'Ground has come loose and something is happening on it.'
    WHEN c.is_contestable
      THEN 'Ground has come loose but nothing is driving it right now.'
    WHEN p.pressure_band = 'HIGH'
      THEN 'The arithmetic writes this ward off, but it is under real pressure.'
    ELSE 'Neither displacement nor pressure.'
  END                                                               AS target_reading

FROM v_ward_computed c
LEFT JOIN v_ward_pressure p ON p.ward_id = c.ward_id
LEFT JOIN v_priority_rank r ON r.ward_id = c.ward_id;
