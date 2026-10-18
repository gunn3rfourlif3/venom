-- =====================================================================
--  SYNTHETIC DEMONSTRATION DATA for the grievance layer and the
--  repository. Invented, like 002. Load it after 002.
--
--  Grievance summaries here describe SERVICES, never people, because that
--  is the boundary the layer exists under. The schema enforces the cheap
--  part of it; the rest is how the text is written.
-- =====================================================================

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM ward WHERE source = 'SYNTHETIC') THEN
    RAISE EXCEPTION 'Load 002_seed_gauteng_demo.sql first.';
  END IF;
  IF EXISTS (SELECT 1 FROM ward WHERE source = 'iec') THEN
    RAISE EXCEPTION 'Real IEC data is present. Refusing to add synthetic rows.';
  END IF;
END $$;

SELECT setseed(0.17);

-- grievances in roughly a third of wards, concentrated where they would be
CREATE TEMP TABLE seed_issue AS
SELECT
  w.ward_id,
  g,
  random() AS r1, random() AS r2, random() AS r3
FROM (SELECT ward_id FROM ward WHERE source = 'SYNTHETIC') w,
     generate_series(1, 1 + (abs(hashtext(w.ward_id)) % 4)) g
WHERE (abs(hashtext(w.ward_id)) % 100) < 34;

INSERT INTO ward_issue (
  ward_id, category, severity, summary, first_seen, last_seen,
  resolved_at, evidence_url, recorded_by, recorded_at)
SELECT
  ward_id,
  (ARRAY['Water','Electricity','Refuse','Roads','Housing',
         'Sanitation','Safety','Billing']::issue_category[])[1 + floor(r1 * 8)],
  (ARRAY['Low','Moderate','High','Severe']::issue_severity[])[1 + floor(r2 * 4)],
  (ARRAY[
    'Intermittent supply across the eastern section for several weeks',
    'Street lighting out along the main approach road',
    'Refuse collection missed on the scheduled round',
    'Potholes on the arterial route reported repeatedly',
    'Housing list queries unanswered at the regional office',
    'Sewage overflow near the community hall',
    'Transformer failures recurring after each outage',
    'Prepaid metering disputes unresolved at the service point'
  ])[1 + floor(r3 * 8)],
  CURRENT_DATE - (7 + floor(r1 * 70))::int,
  CURRENT_DATE - floor(r2 * 6)::int,
  CASE WHEN r3 < 0.22 THEN CURRENT_DATE - floor(r3 * 4)::int ELSE NULL END,
  'https://example.invalid/synthetic-evidence/' || ward_id || '-' || g,
  'demo-rep',
  now()
FROM seed_issue;

-- outages, mostly unplanned, within the pressure window
INSERT INTO service_outage (
  ward_id, municipality, utility, started_at, ended_at, planned,
  source, source_url, source_fetched_at)
SELECT
  s.ward_id, w.municipality,
  (ARRAY['Water','Electricity','Refuse']::issue_category[])[1 + floor(s.r1 * 3)],
  now() - ((2 + floor(s.r2 * 26)) || ' days')::interval,
  CASE WHEN s.r3 < 0.82
       THEN now() - ((2 + floor(s.r2 * 26)) || ' days')::interval
                  + ((2 + floor(s.r3 * 40)) || ' hours')::interval
       ELSE NULL END,
  s.r3 > 0.78,
  'SYNTHETIC', 'https://example.invalid/synthetic-outage', now()
FROM seed_issue s
JOIN ward w USING (ward_id)
WHERE s.r2 < 0.55;

-- ---------------------------------------------------------------
-- the repository
-- ---------------------------------------------------------------

INSERT INTO document (
  title, kind, sensitivity, summary, storage_uri, document_date,
  author, contains_personal_data, retention_until, added_by)
VALUES
 ('Gauteng ward targeting strategy, October','Strategy','Internal',
  'Approach to ward selection for the 2026 municipal elections across the nine Gauteng municipalities.',
  's3://venom-docs/strategy/gauteng-targeting-oct.pdf','2026-10-02',
  'Campaign strategy', false, NULL, 'demo-admin'),
 ('Provincial coordinating meeting, 9 October','Minutes','Internal',
  'Resource allocation across municipalities; transport rate review; candidate recruitment status.',
  's3://venom-docs/minutes/2026-10-09.pdf','2026-10-09',
  'Secretariat', false, NULL, 'demo-admin'),
 ('Transport supplier agreement','Agreement','Restricted',
  'Per-vehicle rates and terms for deployment transport.',
  's3://venom-docs/agreements/transport-2026.pdf','2026-09-18',
  'Operations', false, NULL, 'demo-admin'),
 ('Candidate nomination pack, Mogale City','Nomination','Restricted',
  'Nomination forms and supporting documents for ward candidates.',
  's3://venom-docs/nominations/mogale-city.pdf','2026-10-11',
  'Candidate office', true, '2027-06-30', 'demo-admin'),
 ('Service delivery grievance summary, Emfuleni','Evidence','Internal',
  'Consolidated public reporting on water and electricity interruptions.',
  's3://venom-docs/evidence/emfuleni-services.pdf','2026-10-14',
  'Research', false, NULL, 'demo-rep'),
 ('Volunteer indemnity register','Legal','Restricted',
  'Signed indemnity forms held for deployment volunteers.',
  's3://venom-docs/legal/indemnity-register.pdf','2026-08-30',
  'Legal', true, '2026-10-01', 'demo-admin');

INSERT INTO document_ward (document_id, ward_id)
SELECT d.document_id, w.ward_id
FROM document d
CROSS JOIN LATERAL (
  SELECT ward_id FROM ward
  WHERE source = 'SYNTHETIC'
    AND (d.title LIKE '%Mogale%'   AND municipality = 'Mogale City'
      OR d.title LIKE '%Emfuleni%' AND municipality = 'Emfuleni')
  LIMIT 4
) w;

INSERT INTO decision (
  taken_on, scope, ward_id, municipality, headline, rationale,
  alternatives, taken_by, model_state, outcome, outcome_on)
SELECT
  CURRENT_DATE - 9, 'Municipality', NULL, 'Emfuleni',
  'Shift two transport allocations from Tshwane to Emfuleni',
  'Emfuleni shows the strongest rival decline in the province alongside sustained water and electricity pressure. Tshwane wards at comparable rank are quiet.',
  'Hold the Tshwane allocation and fund Emfuleni from central reserve.',
  'demo-admin',
  jsonb_build_object('basis','v_ward_target','as_of', now(),
                     'note','ACT NOW count in Emfuleni at time of decision'),
  'Transport moved. Two further wards requested the same.', CURRENT_DATE - 2;

INSERT INTO decision (
  taken_on, scope, ward_id, headline, rationale, taken_by, model_state)
SELECT
  CURRENT_DATE - 4, 'Ward', t.ward_id,
  'Open candidate recruitment in ' || t.ward_id,
  'Ward is contestable on rival decline and carries live service pressure, with no candidate confirmed.',
  'demo-admin',
  to_jsonb(t)
FROM v_ward_target t
WHERE t.target_class = 'ACT NOW' AND t.gap_flag = 'URGENT'
ORDER BY t.priority_rank
LIMIT 3;

-- an unevidenced decision, so the flag has something to catch
INSERT INTO decision (taken_on, scope, headline, rationale, taken_by)
VALUES (CURRENT_DATE - 6, 'Campaign',
  'Raise the contestability threshold to 0.06',
  'Too many wards were classifying as contestable to action meaningfully.',
  'demo-admin');

INSERT INTO decision_evidence (decision_id, document_id, note)
SELECT d.decision_id, doc.document_id, 'Primary supporting document'
FROM decision d
JOIN document doc ON doc.title LIKE '%Emfuleni%'
WHERE d.municipality = 'Emfuleni';

INSERT INTO decision_evidence (decision_id, source_url, note)
SELECT d.decision_id,
       'https://example.invalid/synthetic-evidence/' || d.ward_id,
       'Ward issue register at time of decision'
FROM decision d WHERE d.scope = 'Ward';

COMMIT;
