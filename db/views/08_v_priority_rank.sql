-- WINDOW 8 — v_priority_rank
-- Input:  v_ward_computed, v_ward_reliability, v_ward_shortage, control_panel
-- Output: ranked list, box classification, gap flag
--
-- gap_flag = 'NO CANDIDATE' — the ward is contestable and no candidate of
-- ours was certified for it. Permanent, not urgent: see migration 041, which
-- removed the 'Recruit' box because certification closed 16 September 2026.
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
    w.rival_decline_share,
    w.headroom,
    w.pool_owner,
    ce.candidate_status,
    w.is_contestable,
    r.reliability_ratio,
    s.candidate_shortage,
    s.people_shortage,
    s.presence_shortage,
    ce.candidate_status_source,
    ce.list_loaded
  FROM v_ward_computed w
  LEFT JOIN v_ward_reliability r          ON r.ward_id = w.ward_id
  LEFT JOIN v_ward_shortage s             ON s.ward_id = w.ward_id
  LEFT JOIN v_ward_candidate_effective ce ON ce.ward_id = w.ward_id
),
normalised AS (
  SELECT
    b.*,
    PERCENT_RANK() OVER (ORDER BY COALESCE(b.rival_decline_share, 0)) AS n_swing,
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
      WHEN n.is_contestable AND n.candidate_status IN ('None','Pending')  THEN 'PR'
      WHEN n.candidate_status = 'Confirmed'                               THEN 'Hold'
      ELSE 'Abandon'
    END                                                              AS recommended_box,

    -- Order of operational urgency. The score alone buried the boxes that
    -- matter: on 523 wards, rank 1 was an Abandon ward, the only Contest
    -- ward sat at 81 and both URGENT wards at 205 and 242. Where
    -- displacement is negative almost everywhere its percentile is noise,
    -- so headroom and reliability decided the order and neither has
    -- anything to do with contestability.
    --   1 Contest  contestable and a certified candidate of ours is standing
    --   2 PR       contestable, no candidate of ours; the list ballot only
    --   3 Hold     holding what we have
    --   4 Abandon  not contestable, no candidate
    CASE
      WHEN n.is_contestable AND n.candidate_status = 'Confirmed'          THEN 1
      WHEN n.is_contestable AND n.candidate_status IN ('None','Pending')  THEN 2
      WHEN n.candidate_status = 'Confirmed'                               THEN 3
      ELSE 4
    END                                                              AS box_priority
  FROM normalised n
  CROSS JOIN control_panel cp
)
SELECT
  ward_id, zone, municipality, swing_index, rival_decline_share, headroom,
  pool_owner, candidate_status, is_contestable, reliability_ratio,
  candidate_shortage, people_shortage, presence_shortage,
  n_swing, n_headroom, n_reliability, priority_score, recommended_box,
  box_priority,
  -- Box first, score within the box.
  ROW_NUMBER() OVER (ORDER BY box_priority, priority_score DESC, ward_id)
                                                                     AS priority_rank,
  -- The score's own ordering, kept so the two can be compared.
  ROW_NUMBER() OVER (ORDER BY priority_score DESC, ward_id)          AS score_rank,
  CASE WHEN recommended_box = 'PR' THEN 'NO CANDIDATE' ELSE NULL END AS gap_flag,
  candidate_status_source,
  list_loaded
FROM scored;

COMMENT ON VIEW v_priority_rank IS
  'Ranked wards with a recommended action. candidate_status is answered from '
  'the IEC certified list where loaded and from the campaign-entered column '
  'where not; candidate_status_source says which. There is no "Recruit" box: '
  'lists were certified 16 September 2026 and no ward candidate can be added.';
