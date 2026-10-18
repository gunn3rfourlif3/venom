-- WINDOW 3 — v_ward_shortage
-- Input:  v_ward_computed, v_ward_reliability, station, asset_holding
-- Output: the liability side of the ledger — what each ward owes
--
-- Three liability lines. Each one is a workstream.

CREATE VIEW v_ward_shortage AS
WITH station_agg AS (
  SELECT ward_id,
         COUNT(*)                                          AS stations_total,
         COUNT(*) FILTER (WHERE our_people > 0)            AS stations_covered,
         SUM(pledges)                                      AS pledges_total
  FROM station GROUP BY ward_id
),
asset_agg AS (
  SELECT ward_id,
         SUM(quantity) FILTER (WHERE asset_type = 'Door-to-door'
                               AND status = 'Available')   AS people_available
  FROM asset_holding
  WHERE ward_id <> 'CENTRAL'
  GROUP BY ward_id
)
SELECT
  w.ward_id,

  -- liability 1: no candidate where swing is real
  CASE WHEN w.swing_index > 5 AND w.candidate_status <> 'Confirmed'
       THEN 1 ELSE 0 END                                   AS candidate_shortage,

  -- liability 2: people needed vs people present
  GREATEST(0, COALESCE(r.m1_discounted,0)
             - COALESCE(a.people_available,0))             AS people_shortage,

  -- liability 3: swing ward with no station covered
  CASE WHEN w.swing_index > 5
        AND COALESCE(s.stations_covered,0) = 0
       THEN 1 ELSE 0 END                                   AS presence_shortage,

  -- evidence for the audit
  COALESCE(s.stations_total,0)                             AS stations_total,
  COALESCE(s.stations_covered,0)                           AS stations_covered,
  COALESCE(s.pledges_total,0)                              AS pledges_total

FROM v_ward_computed w
LEFT JOIN v_ward_reliability r ON r.ward_id = w.ward_id
LEFT JOIN station_agg s        ON s.ward_id = w.ward_id
LEFT JOIN asset_agg a          ON a.ward_id = w.ward_id;
