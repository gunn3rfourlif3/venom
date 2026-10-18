-- control_panel — every tunable constant in one place.
--
-- Single row, enforced by the boolean primary key. Every view that needs a
-- rate, a weight or a threshold cross joins this table. Nothing is hardcoded
-- in a view any more.

CREATE TABLE control_panel (
  id                       boolean      PRIMARY KEY DEFAULT true CHECK (id),

  -- costs
  transport_rate_per_body  numeric(10,2) NOT NULL DEFAULT 150,
  catering_rate_per_head   numeric(10,2) NOT NULL DEFAULT 80,

  -- model factors
  leakage_factor           numeric(5,4) NOT NULL DEFAULT 0.10
                           CHECK (leakage_factor >= 0 AND leakage_factor <= 1),
  reliability_default      numeric(5,4) NOT NULL DEFAULT 0.50
                           CHECK (reliability_default >= 0 AND reliability_default <= 1),

  -- contestability threshold, as a SHARE of the 2024 pool, not a vote count.
  -- A raw-count threshold tuned for one province misclassifies another:
  -- see db/AUDIT.md. Express it as a share so it travels.
  swing_threshold_share    numeric(5,4) NOT NULL DEFAULT 0.05
                           CHECK (swing_threshold_share >= 0 AND swing_threshold_share <= 1),

  -- priority score weights; must sum to 1
  weight_swing             numeric(4,3) NOT NULL DEFAULT 0.400,
  weight_headroom          numeric(4,3) NOT NULL DEFAULT 0.300,
  weight_reliability       numeric(4,3) NOT NULL DEFAULT 0.300,

  -- which past elections establish peak_turnout_pct.
  -- 'LGE' = local government only. 'ALL' includes national and provincial,
  -- which sets a ceiling a municipal election will not reach and inflates
  -- every a_potential_votes figure. Default is LGE for that reason.
  peak_basis               text         NOT NULL DEFAULT 'LGE'
                           CHECK (peak_basis IN ('LGE', 'ALL')),

  updated_at               timestamptz  NOT NULL DEFAULT now(),
  updated_by               text,

  CONSTRAINT weights_sum_to_one
    CHECK (weight_swing + weight_headroom + weight_reliability = 1.000)
);

INSERT INTO control_panel (id) VALUES (true);
