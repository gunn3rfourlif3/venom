-- WINDOW 8 — v_priority_rank
-- Input:  v_ward_computed, v_ward_reliability, v_ward_shortage, control_panel
-- Output: ranked list, box classification, gap flag
--
-- gap_flag = 'URGENT' is the emergency list — swing exists, candidate doesn't.

CREATE VIEW v_priority_rank AS
WITH scored AS (
  SELECT
    w.ward_id,
    w.zone,
    w.swing_index,
    w.headroom,
    w.pool_owner,
    w.candidate_status,
    r.reliability_ratio,
    s.candidate_shortage,
    s.people_shortage,
    s.presence_shortage,

    -- priority score: swing 40%, headroom 30%, reliability 30%
    ROUND(
      (w.swing_index * 0.4)
      + ((w.headroom / 1000.0) * 0.3)
      + (COALESCE(r.reliability_ratio, 0) * 0.3)
    , 2)                                                     AS priority_score,

    -- recommended box from the data
    CASE
      WHEN w.swing_index > 5 AND w.candidate_status = 'Confirmed' THEN 'Contest'
      WHEN w.swing_index > 5 AND w.candidate_status IN ('None','Pending') THEN 'Recruit'
      WHEN w.candidate_status = 'Confirmed' THEN 'Hold'
      ELSE 'Abandon'
    END                                                      AS recommended_box

  FROM v_ward_computed w
  LEFT JOIN v_ward_reliability r ON r.ward_id = w.ward_id
  LEFT JOIN v_ward_shortage s    ON s.ward_id = w.ward_id
)
SELECT
  *,
  ROW_NUMBER() OVER (ORDER BY priority_score DESC)            AS priority_rank,
  CASE WHEN recommended_box = 'Recruit' THEN 'URGENT' ELSE NULL END AS gap_flag
FROM scored;
