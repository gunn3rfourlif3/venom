-- WINDOW 11 — v_ward_pressure
-- Input:  ward_issue, service_outage, control_panel
-- Output: how much is going wrong in each ward, right now
--
-- pressure_index is an ORDINAL, not a measurement. It counts evidenced
-- grievances weighted by severity and adds recent outage events. It is
-- comparable BETWEEN wards at a point in time. It is not a rate, a
-- probability or a percentage, and nothing should treat it as one.
--
-- The components are all exposed so the index can be argued with.

CREATE VIEW v_ward_pressure AS
WITH issues AS (
  SELECT
    i.ward_id,
    COUNT(*) FILTER (WHERE i.resolved_at IS NULL)                      AS open_issues,
    COUNT(*) FILTER (WHERE i.resolved_at IS NULL
                       AND i.severity IN ('High','Severe'))            AS serious_issues,
    COUNT(*) FILTER (WHERE i.resolved_at IS NULL
                       AND i.severity = 'Severe')                      AS severe_issues,
    MAX(i.last_seen) FILTER (WHERE i.resolved_at IS NULL)              AS newest_issue_seen,
    -- severity weights: Low 1, Moderate 2, High 4, Severe 7
    COALESCE(SUM(CASE i.severity
                   WHEN 'Low' THEN 1 WHEN 'Moderate' THEN 2
                   WHEN 'High' THEN 4 ELSE 7 END)
             FILTER (WHERE i.resolved_at IS NULL), 0)                  AS issue_weight
  FROM ward_issue i
  GROUP BY i.ward_id
),
outages AS (
  SELECT
    o.ward_id,
    COUNT(*)                                                           AS outage_events,
    COUNT(*) FILTER (WHERE NOT o.planned)                              AS unplanned_outages,
    ROUND(COALESCE(SUM(EXTRACT(EPOCH FROM
      (COALESCE(o.ended_at, now()) - o.started_at)) / 3600.0), 0)::numeric, 1)
                                                                       AS outage_hours,
    MAX(o.started_at)                                                  AS newest_outage_at
  FROM service_outage o
  CROSS JOIN control_panel cp
  WHERE o.ward_id IS NOT NULL
    AND o.started_at >= now() - (cp.pressure_window_days || ' days')::interval
  GROUP BY o.ward_id
)
SELECT
  w.ward_id,

  COALESCE(i.open_issues, 0)                                           AS open_issues,
  COALESCE(i.serious_issues, 0)                                        AS serious_issues,
  COALESCE(i.severe_issues, 0)                                         AS severe_issues,
  i.newest_issue_seen,
  CASE WHEN i.newest_issue_seen IS NOT NULL
       THEN (CURRENT_DATE - i.newest_issue_seen) END                   AS days_since_issue,

  COALESCE(o.outage_events, 0)                                         AS outage_events,
  COALESCE(o.unplanned_outages, 0)                                     AS unplanned_outages,
  COALESCE(o.outage_hours, 0)                                          AS outage_hours,
  o.newest_outage_at,

  -- weighted grievance count plus unplanned outages in the window
  (COALESCE(i.issue_weight, 0) + COALESCE(o.unplanned_outages, 0))     AS pressure_index,

  CASE
    WHEN (COALESCE(i.issue_weight,0) + COALESCE(o.unplanned_outages,0)) >= cp.pressure_high_at
      THEN 'HIGH'
    WHEN (COALESCE(i.issue_weight,0) + COALESCE(o.unplanned_outages,0)) >= cp.pressure_elevated_at
      THEN 'ELEVATED'
    WHEN (COALESCE(i.issue_weight,0) + COALESCE(o.unplanned_outages,0)) > 0
      THEN 'LOW'
    ELSE 'QUIET'
  END                                                                  AS pressure_band,

  cp.pressure_window_days
FROM ward w
CROSS JOIN control_panel cp
LEFT JOIN issues  i ON i.ward_id = w.ward_id
LEFT JOIN outages o ON o.ward_id = w.ward_id;
