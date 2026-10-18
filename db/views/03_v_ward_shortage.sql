-- WINDOW 3 — v_ward_shortage
-- Input:  v_ward_computed, v_ward_reliability, station, asset_holding, location
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
  -- ward-held door-to-door capacity only. Central and depot stock is excluded
  -- by location kind rather than by a sentinel string in a key column.
  SELECT l.ward_id,
         SUM(ah.quantity)                                  AS people_available
  FROM asset_holding ah
  JOIN location l ON l.location_id = ah.location_id
  WHERE l.kind = 'ward'
    AND ah.asset_type = 'Door-to-door'
    AND ah.status = 'Available'
  GROUP BY l.ward_id
)
SELECT
  w.ward_id,

  -- liability 1: no candidate where the ward is contestable
  CASE WHEN w.is_contestable AND w.candidate_status <> 'Confirmed'
       THEN 1 ELSE 0 END                                   AS candidate_shortage,

  -- liability 2: people needed vs people present
  GREATEST(0, COALESCE(r.m1_discounted,0)
             - COALESCE(a.people_available,0))             AS people_shortage,

  -- liability 3: contestable ward with no station covered
  CASE WHEN w.is_contestable
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
