-- WINDOW 14 — v_document_register
-- Input:  document, document_ward, app_user
-- Output: the register, with retention status
--
-- retention_status is the column that keeps this honest. A repository
-- accumulates personal data by gravity, and the only thing that stops that
-- becoming a liability is somebody actually seeing what is overdue.

CREATE VIEW v_document_register AS
SELECT
  d.document_id,
  d.title,
  d.kind,
  d.sensitivity,
  d.summary,
  d.document_date,
  d.author,
  d.storage_uri,
  d.contains_personal_data,
  d.retention_until,

  CASE
    WHEN NOT d.contains_personal_data              THEN 'N/A'
    WHEN d.retention_until < CURRENT_DATE          THEN 'OVERDUE'
    WHEN d.retention_until < CURRENT_DATE + 30     THEN 'DUE SOON'
    ELSE 'CURRENT'
  END                                                       AS retention_status,
  CASE WHEN d.contains_personal_data
       THEN (d.retention_until - CURRENT_DATE) END          AS days_to_retention,

  u.display_name                                            AS added_by,
  d.added_at,
  COALESCE(array_agg(dw.ward_id) FILTER (WHERE dw.ward_id IS NOT NULL),
           ARRAY[]::text[])                                 AS wards
FROM document d
LEFT JOIN app_user u       ON u.user_id = d.added_by
LEFT JOIN document_ward dw ON dw.document_id = d.document_id
GROUP BY d.document_id, u.display_name;
