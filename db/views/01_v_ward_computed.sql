-- WINDOW 1 — v_ward_computed
-- Input:  ward
-- Output: swing, headroom, pool share, cost per body, activation gap
--
-- NOTE: 150 is the transport rate placeholder.
--       Pull from control_panel.transport_rate in production.

CREATE VIEW v_ward_computed AS
SELECT
  ward_id,
  municipality,
  zone,
  registered_voters,

  -- pool arithmetic
  (t2024_mkp + t2024_anc)                          AS pool_size_2024,
  t2024_mkp - t2024_anc                            AS pool_split,
  NULLIF(t2024_mkp + t2024_anc, 0)                 AS pool_divisor,

  -- our share of the pool
  CASE WHEN (t2024_mkp + t2024_anc) > 0
       THEN t2024_mkp::numeric / (t2024_mkp + t2024_anc)
       ELSE 0 END                                  AS our_pool_share,

  -- displacement and growth
  t2024_mkp - t2021_anc                            AS swing_index,
  registered_voters * (1 - t2024_turnout/100.0)    AS headroom,

  -- activation ceiling
  peak_turnout_pct - t2024_turnout                 AS activation_gap,

  -- classification
  CASE WHEN t2024_mkp > t2024_anc THEN 'OURS' ELSE 'THEIRS' END AS pool_owner,

  -- cost
  CASE WHEN m1_weekday > 0
       THEN (m5_transport_required * 150)::numeric / m1_weekday
       ELSE NULL END                               AS cost_per_body

FROM ward;
