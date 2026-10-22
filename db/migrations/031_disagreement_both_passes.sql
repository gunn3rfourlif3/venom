-- v_slip_disagreement was counting unfinished work as disagreement.
--
-- The view compared pass 1 against pass 2 with an outer join, so a slip that
-- had only been transcribed once produced one row per party with pass_2 NULL,
-- and `IS DISTINCT FROM` dutifully called every one of them a disagreement.
--
-- In testing that looked like a count of 4 where it should have been 1. On
-- election night, with thousands of slips sitting between their first and
-- second pass, "Needs a decision" would have been almost entirely slips that
-- simply had not been typed twice yet — and the handful of real
-- disagreements, the ones that might mean a transcription error or something
-- worse, would have been buried among them.
--
-- This is G31 again: the exceptions table that listed 19,803 identical rows.
-- A screen that shows everything shows nothing, and the failure is the same
-- each time — a query that is correct about rows and wrong about what a
-- person needs to look at.
--
-- A slip with one pass is IN PROGRESS. Only a slip with both passes can
-- disagree. The missing-party case still works and is still the point: once
-- both passes exist, a party present in one and absent from the other reads
-- NULL on the empty side and is flagged.

CREATE OR REPLACE VIEW v_slip_disagreement AS
WITH finished AS (
  -- Slips where two people have now read the same photograph.
  SELECT slip_id
    FROM result_transcription
   GROUP BY slip_id
  HAVING count(DISTINCT pass) = 2
),
pass AS (
  SELECT t.slip_id, t.pass, v.party, v.votes
    FROM result_transcription t
    JOIN result_vote v USING (transcription_id)
   WHERE t.slip_id IN (SELECT slip_id FROM finished)
),
universe AS (
  SELECT DISTINCT slip_id, party FROM pass
)
SELECT c.station_id,
       c.ballot,
       c.slip_id,
       u.party,
       p1.votes AS pass_1,
       p2.votes AS pass_2
  FROM v_slip_current c
  JOIN universe u   ON u.slip_id = c.slip_id
  LEFT JOIN pass p1 ON p1.slip_id = u.slip_id AND p1.party = u.party AND p1.pass = 1
  LEFT JOIN pass p2 ON p2.slip_id = u.slip_id AND p2.party = u.party AND p2.pass = 2
 WHERE p1.votes IS DISTINCT FROM p2.votes;

COMMENT ON VIEW v_slip_disagreement IS
  'Party lines where two completed passes disagree. Slips awaiting a second '
  'pass are in progress, not disputed, and are excluded.';
