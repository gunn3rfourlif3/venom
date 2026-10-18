-- WINDOW 8 — v_priority_rank
-- Input:  v_ward_computed, v_ward_reliability, v_ward_shortage, control_panel
-- Output: ranked list, box classification, gap flag
--
-- gap_flag = 'URGENT' is the emergency list — the ward is contestable and
-- there is no candidate.
--
-- NORMALISATION: the three inputs are in incompatible units — swing_share is
-- 0-1, headroom is a count of voters, reliability_ratio is 0-1. Weighting
-- them directly gave the vote-count term almost all of the influence
-- whatever the weights said. Each term is now converted to its percentile
-- rank across the ward set before weighting, so a weight of 0.4 means 0.4 of
-- the influence. Percentile rank rather than min-max because one outlier
-- ward would otherwise compress every other ward into the bottom of the
-- scale.

CREATE VIEW v_priority_rank AS
WITH base AS (
  SELECT
    w.ward_id,
    w.zone,
    w.municipality,
    w.swing_index,
    w.swing_share,
    w.headroom,
    w.pool_owner,
    w.candidate_status,
    w.is_contestable,
    r.reliability_ratio,
    s.candidate_shortage,
    s.people_shortage,
    s.presence_shortage
  FROM v_ward_computed w
  LEFT JOIN v_ward_reliability r ON r.ward_id = w.ward_id
  LEFT JOIN v_ward_shortage s    ON s.ward_id = w.ward_id
),
normalised AS (
  SELECT
    b.*,
    PERCENT_RANK() OVER (ORDER BY b.swing_share)                    AS n_swing,
    PERCENT_RANK() OVER (ORDER BY b.headroom)                       AS n_headroom,
    PERCENT_RANK() OVER (ORDER BY COALESCE(b.reliability_ratio, 0)) AS n_reliability
  FROM base b
),
scored AS (
  SELECT
    n.*,
    ROUND(( n.n_swing       * cp.weight_swing
          + n.n_headroom    * cp.weight_headroom
          + n.n_reliability * cp.weight_reliability )::numeric, 4)   AS priority_score,

    CASE
      WHEN n.is_contestable AND n.candidate_status = 'Confirmed'          THEN 'Contest'
      WHEN n.is_contestable AND n.candidate_status IN ('None','Pending')  THEN 'Recruit'
      WHEN n.candidate_status = 'Confirmed'                               THEN 'Hold'
      ELSE 'Abandon'
    END                                                              AS recommended_box
  FROM normalised n
  CROSS JOIN control_panel cp
)
SELECT
  *,
  ROW_NUMBER() OVER (ORDER BY priority_score DESC, ward_id)          AS priority_rank,
  CASE WHEN recommended_box = 'Recruit' THEN 'URGENT' ELSE NULL END  AS gap_flag
FROM scored;
