-- SUPPLY_OK is claiming more than it knows.
--
-- `v_booth_logistics` derives the supply flag from counts of deployments by
-- arrival_status, with SUPPLY_OK as the else branch. A ward with no
-- deployments at all therefore has zero failed and zero partial, falls to
-- the else, and every station in it reports supply OK - on a register where
-- nothing has been dispatched yet, that is 23,276 stations all stating that
-- their supply is fine.
--
-- It is the same fault as the spec's NULL expected_people reading as
-- STAFFED, as is_contestable's ELSE false, and as the heat map painting
-- unmeasured wards calm. It is worth naming for the fifth time: AN ELSE
-- BRANCH THAT MEANS "GOOD" WILL EVENTUALLY BE REACHED BY ROWS THAT SIMPLY
-- HAVE NO DATA. The absence of bad news is not good news.
--
-- WHY THIS FILE EXISTS WHEN 028_supply_none.sql ALREADY DID.
--
-- That file was written but never committed, so it reached no repository and
-- no database. It also could not be applied as written: it does a bare
-- DROP VIEW, and `028_alerts.sql` - which sorts BEFORE it - builds
-- v_alert_conditions on top of v_booth_logistics. Running it raised
-- "cannot drop view v_booth_logistics because other objects depend on it"
-- and aborted the whole migration run.
--
-- HOW THIS ONE AVOIDS THAT, WITHOUT COPYING ANYONE ELSE'S DEFINITION.
--
-- The dependent views' definitions are read out of the catalogue with
-- pg_get_viewdef, kept, dropped with CASCADE, and replayed afterwards. The
-- obvious alternative - pasting v_alert_conditions' body into this file so
-- it can be recreated - would put a second copy of it in the repository,
-- which is the drift this project has been bitten by repeatedly: two
-- definitions, one edited, nobody told. The catalogue already holds the
-- authoritative text. Read it rather than restate it.
--
-- v_logistics_rollup is the exception and is recreated explicitly, because
-- its definition genuinely changes here: SUPPLY_NONE needs its own count so
-- that "nothing has been dispatched anywhere" does not silently inflate the
-- break count, and does not silently vanish from it either.

DO $do$
DECLARE
  saved   jsonb := '[]'::jsonb;
  rec     record;
  ddl     text;
BEGIN
  IF to_regclass('public.v_booth_logistics') IS NULL THEN
    RAISE NOTICE '052: v_booth_logistics absent - nothing to correct';
    RETURN;
  END IF;

  /* Dependents of v_booth_logistics, deepest last, so replaying in order
     recreates a view only after whatever it reads from exists again.
     v_logistics_rollup is excluded: it is rebuilt from this file. */
  FOR rec IN
    WITH RECURSIVE deps AS (
      SELECT dv.oid, dv.relname::text AS name, 1 AS depth
        FROM pg_depend d
        JOIN pg_rewrite rw ON rw.oid = d.objid
        JOIN pg_class dv   ON dv.oid = rw.ev_class
        JOIN pg_class src  ON src.oid = d.refobjid
       WHERE src.relname = 'v_booth_logistics'
         AND dv.relname <> 'v_booth_logistics'
         AND dv.relkind = 'v'
      UNION
      SELECT dv.oid, dv.relname::text, deps.depth + 1
        FROM deps
        JOIN pg_depend d   ON d.refobjid = deps.oid
        JOIN pg_rewrite rw ON rw.oid = d.objid
        JOIN pg_class dv   ON dv.oid = rw.ev_class
       WHERE dv.oid <> deps.oid AND dv.relkind = 'v'
    )
    SELECT name, max(depth) AS depth FROM deps
     WHERE name <> 'v_logistics_rollup'
     GROUP BY name ORDER BY max(depth)
  LOOP
    saved := saved || jsonb_build_object(
      'name', rec.name,
      'ddl', pg_get_viewdef(('public.' || rec.name)::regclass, true));
    RAISE NOTICE '052: keeping definition of %', rec.name;
  END LOOP;

  EXECUTE 'DROP VIEW IF EXISTS v_logistics_rollup';
  EXECUTE 'DROP VIEW IF EXISTS v_booth_logistics CASCADE';

  EXECUTE $v$
  CREATE VIEW v_booth_logistics AS
  WITH deploy AS (
    SELECT d.ward_id,
           COUNT(*)                                             AS total,
           COUNT(*) FILTER (WHERE d.arrival_status = 'arrived') AS arrived,
           COUNT(*) FILTER (WHERE d.arrival_status = 'partial') AS partial,
           COUNT(*) FILTER (WHERE d.arrival_status = 'failed')  AS failed,
           COUNT(*) FILTER (WHERE d.arrival_status = 'pending'
                               OR d.arrival_status IS NULL)     AS pending
    FROM deployment d
    GROUP BY d.ward_id
  )
  SELECT
    s.station_id, s.ward_id, s.name, s.expected_people, s.marshal_name,
    COALESCE(dp.arrived, 0)                        AS ward_supply_arrived,
    COALESCE(dp.partial, 0)                        AS ward_supply_partial,
    COALESCE(dp.failed,  0)                        AS ward_supply_failed,
    COALESCE(dp.total,   0)                        AS ward_deployments,
    CASE
      -- Nothing was ever dispatched to this ward. Not good, not bad: unknown.
      WHEN COALESCE(dp.total, 0) = 0       THEN 'SUPPLY_NONE'
      WHEN COALESCE(dp.failed, 0) > 0      THEN 'SUPPLY_BROKEN'
      WHEN COALESCE(dp.partial, 0) > 0     THEN 'SUPPLY_PARTIAL'
      -- Dispatched but not marked arrived is in transit, not delivered.
      WHEN COALESCE(dp.arrived, 0) = 0     THEN 'SUPPLY_PENDING'
      ELSE 'SUPPLY_OK'
    END                                            AS supply_flag,
    COALESCE(l.people_on_site, 0)                  AS people_now,
    CASE
      WHEN l.reported_at IS NULL                            THEN 'NO_REPORT'
      WHEN l.minutes_since_report > cp.report_stale_minutes THEN 'STALE'
      WHEN COALESCE(l.people_on_site, 0) = 0                THEN 'UNSTAFFED'
      WHEN s.expected_people IS NULL                        THEN 'NO_PLAN'
      WHEN l.people_on_site < s.expected_people * cp.understaffed_ratio
                                                            THEN 'UNDERSTAFFED'
      ELSE 'STAFFED'
    END                                            AS presence_flag,
    COALESCE(l.queue, 'unknown')                   AS queue,
    COALESCE(l.problem_severity, 'none')           AS severity,
    l.problem, l.reported_at, l.minutes_since_report
  FROM station s
  CROSS JOIN control_panel cp
  LEFT JOIN v_booth_status_live l ON l.station_id = s.station_id
  LEFT JOIN deploy dp             ON dp.ward_id  = s.ward_id
  $v$;

  /* SUPPLY_NONE gets its own count rather than joining the break total.
     "Nothing has been dispatched anywhere" is worth knowing on the morning
     of the 4th, and it is not the same alarm as "a delivery failed". */
  EXECUTE $v$
  CREATE VIEW v_logistics_rollup AS
  SELECT
    COUNT(*) FILTER (WHERE supply_flag = 'SUPPLY_BROKEN')          AS supply_breaks,
    COUNT(*) FILTER (WHERE supply_flag = 'SUPPLY_NONE')            AS supply_not_dispatched,
    COUNT(*) FILTER (WHERE presence_flag = 'UNSTAFFED')            AS stations_unstaffed,
    COUNT(*) FILTER (WHERE presence_flag IN ('NO_REPORT','STALE')) AS stations_blind,
    COUNT(*) FILTER (WHERE severity = 'high')                      AS active_high_problems,
    COUNT(*) FILTER (WHERE presence_flag = 'NO_PLAN')              AS stations_no_plan,
    COUNT(*)                                                       AS stations_total,
    ROUND(100.0 * COUNT(*) FILTER (WHERE presence_flag = 'STAFFED')
          / NULLIF(COUNT(*), 0), 1)                                AS staffed_pct
  FROM v_booth_logistics
  $v$;

  -- Put back whatever CASCADE took with it, from the catalogue's own text.
  FOR rec IN SELECT * FROM jsonb_array_elements(saved) AS t(v) LOOP
    ddl := 'CREATE OR REPLACE VIEW ' || (rec.v->>'name') || ' AS ' || (rec.v->>'ddl');
    EXECUTE ddl;
    RAISE NOTICE '052: restored %', rec.v->>'name';
  END LOOP;
END
$do$;

/* Prove the fix, in the migration. The whole point is that a ward with no
   deployments must no longer report SUPPLY_OK; asserting it here means a
   future edit that reintroduces the else branch fails loudly rather than
   quietly telling 23,000 stations their supply is fine. */
DO $$
DECLARE
  wrong bigint;
BEGIN
  SELECT count(*) INTO wrong
    FROM v_booth_logistics
   WHERE ward_deployments = 0 AND supply_flag <> 'SUPPLY_NONE';
  IF wrong > 0 THEN
    RAISE EXCEPTION
      '% stations with no deployments are not reporting SUPPLY_NONE', wrong;
  END IF;
  RAISE NOTICE '052: verified - undispatched wards report SUPPLY_NONE';
END
$$;
