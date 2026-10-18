-- leakage_basis — which reading of "leakage" drives the EO arithmetic.
--
-- The original term charged ten per cent of EVERYONE who voted in the ward
-- against us: the rival's voters, minor parties, all of them. On 523 wards
-- that averaged 1156 votes against an average potential of 2221, so it ate
-- more than half our own ceiling before anything else happened, and 430 of
-- 523 wards reported a NEGATIVE expected outcome. You cannot lose votes you
-- were never going to get.
--
-- Three defensible readings, all three now computed and exposed so they can
-- be compared, with this setting choosing which one eo_est_votes follows:
--
--   ALL         registered x turnout x factor
--               Ten per cent of every vote cast in the ward. The original.
--               Retained for comparison; produces negative EO.
--
--   POOL_SHARE  ALL x our_pool_share
--               Our share of the whole electorate's drift.
--
--   OWN_VOTE    t2024_mkp x factor                           [default]
--               Ten per cent of the people who actually voted for us.
--               The literal reading, and the one that can be said out loud
--               without qualification.
--
-- On the seeded province: average leakage 1156 / 301 / 220, wards with a
-- negative EO 430 / 0 / 0, campaign EO -181656 / +265242 / +307916.

ALTER TABLE control_panel
  ADD COLUMN leakage_basis text NOT NULL DEFAULT 'OWN_VOTE'
    CHECK (leakage_basis IN ('ALL', 'POOL_SHARE', 'OWN_VOTE'));

COMMENT ON COLUMN control_panel.leakage_basis IS
  'Which base the leakage term is charged against. ALL is the original and '
  'produces a negative EO in most wards; it is kept only for comparison.';
