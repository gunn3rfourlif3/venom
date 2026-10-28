-- The candidate question is closed, and two views still treat it as open.
--
-- WHAT WAS WRONG. `ward.candidate_status` is a campaign-entered column with
-- three values - None, Pending, Confirmed - and nothing writes to it except a
-- human. On 28 October it held 'Confirmed' for 180 wards and 'Pending' for 90,
-- all of them in Gauteng, all of them from `db/test/002_seed_gauteng_demo.sql`.
-- Against the IEC's certified list, loaded in migration 040, it disagreed in
-- 310 of Gauteng's 526 wards. 207 wards marked 'None' have a certified ward
-- candidate of ours standing in them. 13 marked 'Confirmed' have nobody.
--
-- WHAT WAS WORSE. `v_priority_rank` turned 'None' or 'Pending' on a
-- contestable ward into `recommended_box = 'Recruit'`, gave it
-- `box_priority = 1` - ahead of every other box - and flagged it
-- `gap_flag = 'URGENT'`. The UI renders that as "Winnable, and nobody is
-- standing. Find a candidate first."
--
-- Candidate lists were certified on 16 September 2026. They cannot change.
-- There is no candidate to find. The single most urgent instruction the
-- system issued, sorted to the top of the ranking, was an action that became
-- impossible six weeks before it was displayed. A ward organiser who followed
-- it would spend the last week of the campaign recruiting for a ballot that
-- was printed in September.
--
-- WHAT THIS CHANGES.
--
-- 1. `candidate_status` keeps its name, type and position, but the views now
--    answer it from the certified list wherever that list is loaded, and fall
--    back to the campaign-entered column where it is not. A new
--    `candidate_status_source` column says which of the two spoke. The base
--    table is NOT overwritten: it is the campaign's own field, it is still
--    the only answer available for the eight provinces whose lists are not
--    loaded, and derived data does not get to destroy entered data.
--
-- 2. 'Recruit' becomes 'PR'. Where no ward candidate of ours was certified,
--    the ward seat is not on offer at any price, but the PR ballot is - and
--    South African municipal PR is compensatory, so a vote cast there is
--    worth exactly what it is worth in a ward we win. Turnout work in those
--    72 Gauteng wards still pays; it just pays into the list, not the ward.
--    That is a real instruction. "Recruit" was not.
--
-- 3. Box priority is reordered. 'Recruit' sat first because an unfilled
--    winnable ward was the emergency. With filling impossible, the emergency
--    is the opposite: the winnable wards where we DID certify a candidate are
--    the ones where a week of work can still turn into a councillor.
--
-- 4. `gap_flag` keeps its column and its meaning - contestable, no candidate
--    of ours - but says 'NO CANDIDATE' rather than 'URGENT'. The fact is
--    permanent, not urgent, and the two call for different behaviour.
--
-- NOTE ON SCOPE. Only Gauteng's certified list is loaded. Every other
-- province still reads its campaign-entered column, which is 'None'
-- everywhere, so those wards read as 'PR'. That is wrong but it is wrong in a
-- visible, labelled way: `candidate_status_source` says 'campaign-entered'
-- and `list_loaded` is false. The fix is to load the other eight certified
-- lists, not to guess.
--
-- WHY THE SECOND HALF OF THIS FILE IS WRAPPED IN A CONDITIONAL. `migrate.ts`
-- runs db/migrations, then db/views, then db/extract. Every file in db/views
-- uses a plain CREATE VIEW and the runner tolerates the duplicate-object
-- error, which means editing a file in db/views has NO effect on a database
-- that already has that view - a view change has to travel in a migration to
-- reach an existing database. But a migration runs BEFORE db/views exists, so
-- on a fresh build v_ward_computed is not there yet and a redefinition of
-- v_priority_rank would fail on a missing relation.
--
-- Both paths have to work. db/views/03 and db/views/08 carry the canonical
-- new definitions for a fresh build; the block below applies the same change
-- to a database that is already running, and skips silently on a fresh one.
-- The two must be kept in step: if you edit one, edit the other.

-- Depends only on `ward` and on v_ward_candidacy from migration 040, both of
-- which exist by now on every path, so this is unconditional.
CREATE OR REPLACE VIEW v_ward_candidate_effective AS
SELECT
  w.ward_id,
  CASE WHEN vc.list_loaded
       THEN CASE WHEN vc.has_our_candidate THEN 'Confirmed' ELSE 'None' END
       ELSE w.candidate_status
  END                                                     AS candidate_status,
  CASE WHEN vc.list_loaded THEN 'IEC certified'
       ELSE 'campaign-entered' END                        AS candidate_status_source,
  COALESCE(vc.list_loaded, false)                         AS list_loaded
FROM ward w
LEFT JOIN v_ward_candidacy vc ON vc.ward_id = w.ward_id;

COMMENT ON VIEW v_ward_candidate_effective IS
  'Best available answer to "do we field a ward candidate here": the IEC '
  'certified list where it is loaded, the campaign-entered column where it '
  'is not, and a column saying which one answered. Consumers must surface '
  'the source - an entered guess and a certified fact are not the same claim.';


DO $do$
BEGIN
  -- Fresh build: db/views has not run yet and carries these definitions
  -- itself. Nothing to do here.
  IF to_regclass('public.v_ward_computed') IS NULL THEN
    RAISE NOTICE '041: v_ward_computed absent - fresh build, db/views will create the new definitions';
    RETURN;
  END IF;

  EXECUTE $v$
  CREATE OR REPLACE VIEW v_ward_shortage AS
  WITH station_agg AS (
    SELECT ward_id,
           COUNT(*)                                        AS stations_total,
           COUNT(*) FILTER (WHERE our_people > 0)          AS stations_covered,
           SUM(pledges)                                    AS pledges_total
    FROM station GROUP BY ward_id
  ),
  asset_agg AS (
    SELECT l.ward_id,
           SUM(ah.quantity)                                AS people_available
    FROM asset_holding ah
    JOIN location l ON l.location_id = ah.location_id
    WHERE l.kind = 'ward'
      AND ah.asset_type = 'Door-to-door'
      AND ah.status = 'Available'
    GROUP BY l.ward_id
  )
  SELECT
    w.ward_id,
    CASE WHEN w.is_contestable AND ce.candidate_status <> 'Confirmed'
         THEN 1 ELSE 0 END                                 AS candidate_shortage,
    GREATEST(0, COALESCE(r.m1_discounted,0)
               - COALESCE(a.people_available,0))           AS people_shortage,
    CASE WHEN w.is_contestable
          AND COALESCE(s.stations_covered,0) = 0
         THEN 1 ELSE 0 END                                 AS presence_shortage,
    COALESCE(s.stations_total,0)                           AS stations_total,
    COALESCE(s.stations_covered,0)                         AS stations_covered,
    COALESCE(s.pledges_total,0)                            AS pledges_total
  FROM v_ward_computed w
  LEFT JOIN v_ward_reliability r          ON r.ward_id = w.ward_id
  LEFT JOIN station_agg s                 ON s.ward_id = w.ward_id
  LEFT JOIN asset_agg a                   ON a.ward_id = w.ward_id
  LEFT JOIN v_ward_candidate_effective ce ON ce.ward_id = w.ward_id
  $v$;

  EXECUTE $v$
  CREATE OR REPLACE VIEW v_priority_rank AS
  WITH base AS (
    SELECT
      w.ward_id, w.zone, w.municipality, w.swing_index, w.rival_decline_share,
      w.headroom, w.pool_owner,
      ce.candidate_status,            -- position 8, name and type unchanged
      w.is_contestable, r.reliability_ratio,
      s.candidate_shortage, s.people_shortage, s.presence_shortage,
      ce.candidate_status_source, ce.list_loaded
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
        WHEN n.candidate_status = 'Confirmed'                              THEN 'Hold'
        ELSE 'Abandon'
      END                                                            AS recommended_box,
      CASE
        WHEN n.is_contestable AND n.candidate_status = 'Confirmed'         THEN 1
        WHEN n.is_contestable AND n.candidate_status IN ('None','Pending') THEN 2
        WHEN n.candidate_status = 'Confirmed'                              THEN 3
        ELSE 4
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
    list_loaded
  FROM scored
  $v$;

  -- Inside the conditional with the rest. A COMMENT ON a view that does not
  -- exist yet raises, and because Postgres runs a multi-statement file as one
  -- implicit transaction, that failure rolled back the CREATE above it - the
  -- migration reported an error about v_priority_rank while the thing it had
  -- actually failed to leave behind was v_ward_candidate_effective. The
  -- canonical comment for a fresh build lives in db/views/08.
  EXECUTE $v$
  COMMENT ON VIEW v_priority_rank IS
    'Ranked wards with a recommended action. candidate_status is answered from '
    'the IEC certified list where loaded and from the campaign-entered column '
    'where not; candidate_status_source says which. There is no "Recruit" box: '
    'lists were certified 16 September 2026 and no ward candidate can be added.'
  $v$;

  /* THE MATERIALISED VIEW HAS TO BE REFRESHED HERE OR THE CHANGE DOES NOT
     REACH THE SCREEN. /api/wards reads mv_campaign_extract, not
     v_priority_rank, so redefining the view changes nothing a user can see
     until the matview is rebuilt. Before this refresh it held 46 wards in a
     'Recruit' box that no longer has a filter chip or a tooltip - the UI
     would have rendered an unlabelled, unfilterable box, and the first
     person to notice would have been a ward organiser.

     Nothing in `migrate.ts` refreshes it; the refreshes live in daily.ts,
     promote.ts and one API route, none of which run on deploy. A migration
     that changes a view feeding a matview owns the refresh.

     Plain REFRESH, not CONCURRENTLY: the migrator wraps each file in a
     transaction and CONCURRENTLY cannot run inside one. A one-off exclusive
     lock on deploy is the right trade for the change actually landing. */
  IF to_regclass('public.mv_campaign_extract') IS NOT NULL THEN
    REFRESH MATERIALIZED VIEW mv_campaign_extract;
    RAISE NOTICE '041: mv_campaign_extract refreshed';
  END IF;

  RAISE NOTICE '041: v_ward_shortage and v_priority_rank redefined on a live database';
END
$do$;
