-- A ward nobody has measured is not a ward we have decided to give up on.
--
-- WHAT THIS FIXES. `is_contestable` is computed from the rival's decline
-- between 2021 and 2024, which needs t2021_anc, t2024_anc, t2021_turnout,
-- t2024_turnout and registered_voters. Its CASE ends `THEN true ELSE false`,
-- so a ward missing any of those inputs comes out FALSE - identical, to every
-- consumer, to a ward that was measured and found uncontestable.
--
-- On the production database that is every ward. All 4,485 have
-- t2021_anc = 0, t2021_turnout = 0 and t2024_turnout = 0: the baseline has
-- never been loaded. So `v_priority_rank` was placing
--
--     454 wards in  Hold    - "Not winnable, but we hold it. Defend, do not invest."
--   4,031 wards in  Abandon - "Not winnable and nobody standing. Spend the day elsewhere."
--
-- and the system was instructing a campaign to abandon 4,031 wards seven days
-- before a national municipal election, on the strength of data it does not
-- have. Nothing was assessed and found hopeless. Nothing was assessed.
--
-- This is the same fault as migration 028's SUPPLY_OK and as the NULL
-- expected_people that read as STAFFED, and it is worth naming as a pattern
-- for the third time: AN ELSE BRANCH THAT MEANS "NO" WILL EVENTUALLY BE
-- REACHED BY ROWS THAT SIMPLY HAVE NO DATA. The absence of evidence of
-- contestability is not evidence of uncontestability, and a view must not be
-- the place where one is silently converted into the other.
--
-- WHY THIS IS CHEAPER THAN IT LOOKS. `rival_decline_share` is already NULL
-- exactly when those inputs are missing, and `v_priority_rank` already selects
-- it. So the distinction needs no change to `v_ward_computed` and no new
-- column on `ward`: NULL there means "not assessed", and that is all the
-- signal required.
--
-- THE REAL FIX IS STILL THE DATA. This migration stops the system asserting
-- something false. It does not make the ranking useful - with no baseline
-- loaded, 4,485 wards sit in one undifferentiated box and the priority order
-- within it is meaningless. Loading real 2021 ward results is the actual
-- repair; this is the part that can be done without them.

DO $do$
BEGIN
  IF to_regclass('public.v_ward_computed') IS NULL THEN
    RAISE NOTICE '044: fresh build - db/views carries the new definition';
    RETURN;
  END IF;

  EXECUTE $v$
  CREATE OR REPLACE VIEW v_priority_rank AS
  WITH base AS (
    SELECT
      w.ward_id, w.zone, w.municipality, w.swing_index, w.rival_decline_share,
      w.headroom, w.pool_owner,
      ce.candidate_status,
      w.is_contestable, r.reliability_ratio,
      s.candidate_shortage, s.people_shortage, s.presence_shortage,
      ce.candidate_status_source, ce.list_loaded,
      -- NULL decline means the inputs were absent, not that the rival held on.
      (w.rival_decline_share IS NOT NULL) AS contestability_known
    FROM v_ward_computed w
    LEFT JOIN v_ward_reliability r          ON r.ward_id = w.ward_id
    LEFT JOIN v_ward_shortage s             ON s.ward_id = w.ward_id
    LEFT JOIN v_ward_candidate_effective ce ON ce.ward_id = w.ward_id
  ),
  normalised AS (
    SELECT b.*,
      PERCENT_RANK() OVER (ORDER BY COALESCE(b.rival_decline_share, 0)) AS n_swing,
      PERCENT_RANK() OVER (ORDER BY b.headroom)                         AS n_headroom,
      PERCENT_RANK() OVER (ORDER BY COALESCE(b.reliability_ratio, 0))   AS n_reliability
    FROM base b
  ),
  scored AS (
    SELECT n.*,
      ROUND(( n.n_swing       * cp.weight_swing
            + n.n_headroom    * cp.weight_headroom
            + n.n_reliability * cp.weight_reliability )::numeric, 4) AS priority_score,
      CASE
        WHEN n.is_contestable AND n.candidate_status = 'Confirmed'         THEN 'Contest'
        WHEN n.is_contestable AND n.candidate_status IN ('None','Pending') THEN 'PR'
        -- Checked AFTER the two contestable cases, which can only be true
        -- when the data exists, and BEFORE Hold/Abandon, which must not
        -- claim a verdict that was never reached.
        WHEN NOT n.contestability_known                                    THEN 'Unassessed'
        WHEN n.candidate_status = 'Confirmed'                              THEN 'Hold'
        ELSE 'Abandon'
      END                                                            AS recommended_box,
      /* Above Hold and Abandon deliberately. An unmeasured ward is a question
         outstanding; a ward in Hold or Abandon has had its answer.

         Unassessed splits into two sort ranks under one label. On a database
         with no baseline loaded, EVERY ward is unassessed, and a single rank
         would leave 4,485 rows ordered by a priority_score computed entirely
         from COALESCE(NULL, 0) - which is to say, not ordered at all. Whether
         we certified a ward candidate is a fact we hold regardless of the
         baseline, and it is the one that decides whether a ward seat is even
         on offer. So those sort first. The LABEL does not change, because the
         ward still has not been assessed and the box must not imply it has. */
      CASE
        WHEN n.is_contestable AND n.candidate_status = 'Confirmed'         THEN 1
        WHEN n.is_contestable AND n.candidate_status IN ('None','Pending') THEN 2
        WHEN NOT n.contestability_known
             AND n.candidate_status = 'Confirmed'                          THEN 3
        WHEN NOT n.contestability_known                                    THEN 4
        WHEN n.candidate_status = 'Confirmed'                              THEN 5
        ELSE 6
      END                                                            AS box_priority
    FROM normalised n
    CROSS JOIN control_panel cp
  )
  SELECT
    ward_id, zone, municipality, swing_index, rival_decline_share, headroom,
    pool_owner, candidate_status, is_contestable, reliability_ratio,
    candidate_shortage, people_shortage, presence_shortage,
    n_swing, n_headroom, n_reliability, priority_score, recommended_box,
    box_priority,
    ROW_NUMBER() OVER (ORDER BY box_priority, priority_score DESC, ward_id) AS priority_rank,
    ROW_NUMBER() OVER (ORDER BY priority_score DESC, ward_id)               AS score_rank,
    CASE WHEN recommended_box = 'PR' THEN 'NO CANDIDATE' ELSE NULL END      AS gap_flag,
    candidate_status_source,
    list_loaded,
    contestability_known
  FROM scored
  $v$;

  EXECUTE $v$
  COMMENT ON VIEW v_priority_rank IS
    'Ranked wards with a recommended action. There is no "Recruit" box: lists '
    'were certified 16 September 2026. There is an "Unassessed" box: a ward '
    'with no 2021/2024 baseline has not been judged uncontestable, it has not '
    'been judged at all, and must not be reported as Abandon.'
  $v$;

  IF to_regclass('public.mv_campaign_extract') IS NOT NULL THEN
    REFRESH MATERIALIZED VIEW mv_campaign_extract;
    RAISE NOTICE '044: mv_campaign_extract refreshed';
  END IF;

  RAISE NOTICE '044: Unassessed box added';
END
$do$;
