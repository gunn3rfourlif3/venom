-- WINDOW 13 — v_decision_log
-- Input:  decision, decision_evidence, app_user, ward
-- Output: what was decided, on what, by whom, and what came of it
--
-- unevidenced_flag is the point of the view. A decision with no evidence
-- attached is not necessarily wrong, but it is unreviewable, and six weeks
-- later nobody will reconstruct what it rested on.

CREATE VIEW v_decision_log AS
SELECT
  d.decision_id,
  d.taken_on,
  d.scope,
  d.ward_id,
  COALESCE(w.municipality, d.municipality)                  AS municipality,
  d.deployment_id,
  d.headline,
  d.rationale,
  d.alternatives,
  u.display_name                                            AS taken_by,
  d.model_state,

  COUNT(e.decision_evidence_id)                             AS evidence_items,
  COUNT(e.document_id)                                      AS evidence_documents,
  CASE WHEN COUNT(e.decision_evidence_id) = 0
       THEN true ELSE false END                             AS unevidenced_flag,

  d.outcome,
  d.outcome_on,
  CASE WHEN d.outcome IS NULL THEN 'OPEN' ELSE 'CLOSED' END AS outcome_status,
  CASE WHEN d.outcome IS NULL
       THEN (CURRENT_DATE - d.taken_on) END                 AS days_open,

  d.recorded_at
FROM decision d
LEFT JOIN app_user u          ON u.user_id = d.taken_by
LEFT JOIN ward w              ON w.ward_id = d.ward_id
LEFT JOIN decision_evidence e ON e.decision_id = d.decision_id
GROUP BY d.decision_id, w.municipality, u.display_name;
