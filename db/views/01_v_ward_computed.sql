-- WINDOW 1 — v_ward_computed
-- Input:  ward, control_panel
-- Output: swing, headroom, pool share, contestability, activation gap
--
-- Cost per body moved to Window 2, which holds both the numerator
-- (m4_transport_required) and the denominator that matters (m1_discounted).
-- Computing it here would mean either duplicating the discount formula or
-- inverting the dependency order of the two foundation views.

CREATE VIEW v_ward_computed AS
SELECT
  w.ward_id,
  w.municipality,
  w.zone,
  w.province,
  w.registered_voters,

  -- pass-throughs required by Windows 3, 7 and 8
  w.candidate_status,
  w.t2024_turnout,

  -- both peak bases are exposed so the dashboard can show either, and
  -- peak_turnout_pct resolves to whichever one control_panel.peak_basis
  -- selects. Downstream EO arithmetic reads peak_turnout_pct and therefore
  -- follows the setting without being rewritten.
  w.peak_turnout_lge_pct,
  w.peak_turnout_all_pct,
  cp.peak_basis,
  CASE WHEN cp.peak_basis = 'LGE'
       THEN w.peak_turnout_lge_pct
       ELSE w.peak_turnout_all_pct END               AS peak_turnout_pct,

  -- pool arithmetic
  (w.t2024_mkp + w.t2024_anc)                        AS pool_size_2024,
  w.t2024_mkp - w.t2024_anc                          AS pool_split,

  -- our share of the pool
  CASE WHEN (w.t2024_mkp + w.t2024_anc) > 0
       THEN w.t2024_mkp::numeric / (w.t2024_mkp + w.t2024_anc)
       ELSE 0 END                                    AS our_pool_share,

  -- displacement and growth
  w.t2024_mkp - w.t2021_anc                          AS swing_index,

  -- displacement as a SHARE of the pool. A raw vote count is not comparable
  -- between provinces: a threshold tuned where displacement was large
  -- classifies almost every ward the same way where it was small.
  CASE WHEN (w.t2024_mkp + w.t2024_anc) > 0
       THEN (w.t2024_mkp - w.t2021_anc)::numeric / (w.t2024_mkp + w.t2024_anc)
       ELSE 0 END                                    AS swing_share,

  -- contestability, decided once here and read everywhere downstream
  CASE WHEN (w.t2024_mkp + w.t2024_anc) > 0
        AND (w.t2024_mkp - w.t2021_anc)::numeric / (w.t2024_mkp + w.t2024_anc)
            > cp.swing_threshold_share
       THEN true ELSE false END                      AS is_contestable,

  w.registered_voters * (1 - w.t2024_turnout/100.0)  AS headroom,

  -- activation ceiling, floored at zero: a ward already at or past its
  -- historic peak has no activation room. Both bases are given so the two
  -- can be compared side by side; activation_gap follows the active basis.
  GREATEST(0, w.peak_turnout_lge_pct - w.t2024_turnout) AS activation_gap_lge,
  GREATEST(0, w.peak_turnout_all_pct - w.t2024_turnout) AS activation_gap_all,
  GREATEST(0, CASE WHEN cp.peak_basis = 'LGE'
                   THEN w.peak_turnout_lge_pct
                   ELSE w.peak_turnout_all_pct END
              - w.t2024_turnout)                     AS activation_gap,

  -- classification
  CASE WHEN w.t2024_mkp > w.t2024_anc THEN 'OURS' ELSE 'THEIRS' END AS pool_owner

FROM ward w
CROSS JOIN control_panel cp;
