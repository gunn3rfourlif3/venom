-- WINDOW 1 — v_ward_computed
-- Input:  ward, control_panel
-- Output: pool share, rival decline, contestability, headroom, activation gap
--
-- Cost per body lives in Window 2, which holds both the numerator and the
-- denominator that matters.
--
-- TURNOUT BASIS: the contest is a local government election, so every
-- shortfall is measured against t2021_turnout, the last local turnout.
-- t2024_turnout is a national figure and is structurally higher; using it
-- made activation_gap identically zero and understated headroom.

CREATE VIEW v_ward_computed AS
SELECT
  w.ward_id,
  w.municipality,
  w.zone,
  w.province,
  w.registered_voters,

  -- pass-throughs required by Windows 3, 7 and 8
  w.candidate_status,
  w.t2021_turnout,
  w.t2024_turnout,

  -- both peak bases exposed; peak_turnout_pct resolves to whichever
  -- control_panel.peak_basis selects, so downstream follows the setting.
  w.peak_turnout_lge_pct,
  w.peak_turnout_all_pct,
  cp.peak_basis,
  CASE WHEN cp.peak_basis = 'LGE'
       THEN w.peak_turnout_lge_pct
       ELSE w.peak_turnout_all_pct END               AS peak_turnout_pct,

  -- raw party counts, passed through for the leakage bases and the dashboard
  w.t2021_anc,
  w.t2024_mkp,
  w.t2024_anc,

  -- pool arithmetic
  (w.t2024_mkp + w.t2024_anc)                        AS pool_size_2024,
  w.t2024_mkp - w.t2024_anc                          AS pool_split,

  CASE WHEN (w.t2024_mkp + w.t2024_anc) > 0
       THEN w.t2024_mkp::numeric / (w.t2024_mkp + w.t2024_anc)
       ELSE 0 END                                    AS our_pool_share,

  -- LEGACY measure, kept for continuity and diagnosis only. It subtracts a
  -- 2021 LOCAL vote count from a 2024 NATIONAL one: different election,
  -- different turnout, different ballot. Nothing decides anything on it.
  w.t2024_mkp - w.t2021_anc                          AS swing_index,

  -- The rival's share of those who actually voted, at each election.
  -- Shares are comparable where raw counts are not.
  CASE WHEN w.t2021_turnout > 0 AND w.registered_voters > 0
       THEN w.t2021_anc::numeric
            / NULLIF(w.registered_voters * (w.t2021_turnout/100.0), 0)
       ELSE NULL END                                 AS rival_share_2021,

  CASE WHEN w.t2024_turnout > 0 AND w.registered_voters > 0
       THEN w.t2024_anc::numeric
            / NULLIF(w.registered_voters * (w.t2024_turnout/100.0), 0)
       ELSE NULL END                                 AS rival_share_2024,

  -- DISPLACEMENT AVAILABLE: how much share the rival lost between the two.
  -- Positive means ground has come loose. This is what contestability is
  -- decided on, because it measures the rival's decline rather than our
  -- gain in a different election.
  CASE WHEN w.t2021_turnout > 0 AND w.t2024_turnout > 0 AND w.registered_voters > 0
       THEN (w.t2021_anc::numeric / NULLIF(w.registered_voters * (w.t2021_turnout/100.0), 0))
          - (w.t2024_anc::numeric / NULLIF(w.registered_voters * (w.t2024_turnout/100.0), 0))
       ELSE NULL END                                 AS rival_decline_share,

  CASE WHEN w.t2021_turnout > 0 AND w.t2024_turnout > 0 AND w.registered_voters > 0
        AND (w.t2021_anc::numeric / NULLIF(w.registered_voters * (w.t2021_turnout/100.0), 0))
          - (w.t2024_anc::numeric / NULLIF(w.registered_voters * (w.t2024_turnout/100.0), 0))
            > cp.swing_threshold_share
       THEN true ELSE false END                      AS is_contestable,

  -- Non-voters at the last LOCAL election: the pool actually available to
  -- activate at another local election.
  w.registered_voters * (1 - w.t2021_turnout/100.0)  AS headroom,

  -- Activation ceiling: how far local turnout could rise from where it last
  -- stood locally, up to the chosen peak. Floored at zero.
  GREATEST(0, w.peak_turnout_lge_pct - w.t2021_turnout) AS activation_gap_lge,
  GREATEST(0, w.peak_turnout_all_pct - w.t2021_turnout) AS activation_gap_all,
  GREATEST(0, CASE WHEN cp.peak_basis = 'LGE'
                   THEN w.peak_turnout_lge_pct
                   ELSE w.peak_turnout_all_pct END
              - w.t2021_turnout)                     AS activation_gap,

  CASE WHEN w.t2024_mkp > w.t2024_anc THEN 'OURS' ELSE 'THEIRS' END AS pool_owner

FROM ward w
CROSS JOIN control_panel cp;
