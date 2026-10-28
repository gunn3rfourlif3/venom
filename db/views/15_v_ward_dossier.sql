-- WINDOW 15 — v_ward_dossier
-- Input:  everything
-- Output: one row holding all Venom knows about a ward
--
-- This is God's View at ward granularity: the arithmetic, the capacity, the
-- liabilities, the live pressure, the decisions taken and the documents
-- held, in a single row.
--
-- Reads the views directly rather than mv_campaign_extract, so a dossier is
-- always live - the extract is refreshed on write and may be seconds stale,
-- which is fine for a ranked list and not fine when somebody is standing in
-- a meeting defending one ward. Always query it filtered by ward_id.

CREATE VIEW v_ward_dossier AS
SELECT
  c.ward_id,
  c.municipality,
  c.zone,
  c.registered_voters,

  -- the arithmetic
  c.pool_size_2024,
  c.our_pool_share,
  c.rival_share_2021,
  c.rival_share_2024,
  c.rival_decline_share,
  c.is_contestable,
  c.headroom,
  c.activation_gap,
  c.peak_basis,
  c.pool_owner,

  -- the ledger
  e.a_potential_votes,
  e.l_eroding_votes,
  e.eo_est_votes,
  e.eo_act_votes,

  -- capacity, discounted by delivery record
  r.m1_weekday,
  r.m3_last_actual,
  r.reliability_ratio,
  r.m1_discounted,
  r.cost_per_body_planned,

  -- liabilities
  s.candidate_shortage,
  s.people_shortage,
  s.presence_shortage,
  s.stations_total,
  s.stations_covered,
  s.pledges_total,

  -- live pressure
  p.pressure_band,
  p.pressure_index,
  p.open_issues,
  p.serious_issues,
  p.unplanned_outages,
  p.days_since_issue,

  -- the call
  t.target_class,
  t.target_reading,
  pr.recommended_box,
  pr.priority_rank,
  pr.gap_flag,

  -- institutional memory
  COALESCE(dec.decisions_total, 0)                          AS decisions_total,
  COALESCE(dec.decisions_open, 0)                           AS decisions_open,
  dec.last_decision_on,
  COALESCE(doc.documents_total, 0)                          AS documents_total,

  -- Appended by migration 041. "No candidate" sourced from the IEC certified
  -- list and "no candidate" sourced from a blank campaign field are not the
  -- same claim, and the dossier is where someone acts on the difference.
  pr.candidate_status,
  pr.candidate_status_source,
  pr.list_loaded

FROM v_ward_computed c
LEFT JOIN v_ward_eo e          ON e.ward_id  = c.ward_id
LEFT JOIN v_ward_reliability r ON r.ward_id  = c.ward_id
LEFT JOIN v_ward_shortage s    ON s.ward_id  = c.ward_id
LEFT JOIN v_ward_pressure p    ON p.ward_id  = c.ward_id
LEFT JOIN v_ward_target t      ON t.ward_id  = c.ward_id
LEFT JOIN v_priority_rank pr   ON pr.ward_id = c.ward_id
LEFT JOIN (
  SELECT ward_id,
         COUNT(*)                                AS decisions_total,
         COUNT(*) FILTER (WHERE outcome IS NULL) AS decisions_open,
         MAX(taken_on)                           AS last_decision_on
  FROM decision WHERE ward_id IS NOT NULL GROUP BY ward_id
) dec ON dec.ward_id = c.ward_id
LEFT JOIN (
  SELECT ward_id, COUNT(*) AS documents_total
  FROM document_ward GROUP BY ward_id
) doc ON doc.ward_id = c.ward_id;
