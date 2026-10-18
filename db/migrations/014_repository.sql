-- God's View: the repository of what the campaign knows and what it decided.
--
-- Not a file dump. The value is that a DECISION is tied to the EVIDENCE
-- that supported it and the MODEL STATE at the moment it was taken. That
-- closes the same loop calibration closes for the arithmetic, but for
-- judgement: six weeks on you can ask not only whether the forecast was
-- right, but whether the call was reasonable on what was known at the time.
--
-- Venom stores the POINTER to a document, never the bytes. Keeping files in
-- the database makes backups heavy and retention hard to enforce.
--
-- The issues-not-people boundary carries over. A general document store
-- attracts personal data by gravity, so anything holding it must say so and
-- must carry a retention date - enforced below, not left to good intentions.

CREATE TYPE doc_kind AS ENUM (
  'Strategy','Minutes','Agreement','Nomination','Legal',
  'Report','Correspondence','Evidence','Other');

CREATE TYPE doc_sensitivity AS ENUM ('Public','Internal','Restricted');

CREATE TABLE document (
  document_id           bigserial       PRIMARY KEY,
  title                 text            NOT NULL,
  kind                  doc_kind        NOT NULL,
  sensitivity           doc_sensitivity NOT NULL DEFAULT 'Internal',
  summary               text,

  -- where the bytes actually live
  storage_uri           text            NOT NULL,
  content_hash          text,
  document_date         date,
  author                text,

  -- POPIA: anything holding personal data must declare it and must expire
  contains_personal_data boolean        NOT NULL DEFAULT false,
  retention_until       date,

  added_by              text            NOT NULL REFERENCES app_user (user_id),
  added_at              timestamptz     NOT NULL DEFAULT now(),

  search                tsvector GENERATED ALWAYS AS (
                          to_tsvector('english',
                            coalesce(title,'') || ' ' || coalesce(summary,''))
                        ) STORED,

  CONSTRAINT personal_data_must_expire
    CHECK (NOT contains_personal_data OR retention_until IS NOT NULL)
);

CREATE INDEX idx_document_search ON document USING GIN (search);
CREATE INDEX idx_document_kind   ON document (kind, document_date DESC);
CREATE INDEX idx_document_expiry ON document (retention_until)
  WHERE contains_personal_data;

-- a document may bear on a ward, several wards, or none
CREATE TABLE document_ward (
  document_id bigint REFERENCES document (document_id) ON DELETE CASCADE,
  ward_id     text   REFERENCES ward (ward_id),
  PRIMARY KEY (document_id, ward_id)
);

CREATE TYPE decision_scope AS ENUM ('Campaign','Municipality','Ward','Deployment');

CREATE TABLE decision (
  decision_id     bigserial      PRIMARY KEY,
  taken_on        date           NOT NULL,
  scope           decision_scope NOT NULL,
  ward_id         text           REFERENCES ward (ward_id),
  municipality    text,
  deployment_id   bigint         REFERENCES deployment (deployment_id),

  headline        text           NOT NULL,
  rationale       text           NOT NULL,
  alternatives    text,
  taken_by        text           NOT NULL REFERENCES app_user (user_id),

  -- What the model said at the moment the call was made. Held inline rather
  -- than as a pointer into a snapshot table: a decision must stay readable
  -- even after the views are rewritten, and they will be.
  model_state     jsonb,

  -- filled later
  outcome         text,
  outcome_on      date,

  recorded_at     timestamptz    NOT NULL DEFAULT now(),

  search          tsvector GENERATED ALWAYS AS (
                    to_tsvector('english',
                      coalesce(headline,'') || ' ' || coalesce(rationale,'') || ' '
                      || coalesce(alternatives,'') || ' ' || coalesce(outcome,''))
                  ) STORED,

  CONSTRAINT decision_scope_has_subject CHECK (
       (scope = 'Campaign')
    OR (scope = 'Municipality' AND municipality  IS NOT NULL)
    OR (scope = 'Ward'         AND ward_id       IS NOT NULL)
    OR (scope = 'Deployment'   AND deployment_id IS NOT NULL)),
  CONSTRAINT outcome_needs_a_date CHECK (
    (outcome IS NULL) = (outcome_on IS NULL))
);

CREATE INDEX idx_decision_search ON decision USING GIN (search);
CREATE INDEX idx_decision_ward   ON decision (ward_id, taken_on DESC);
CREATE INDEX idx_decision_date   ON decision (taken_on DESC);
CREATE INDEX idx_decision_open   ON decision (taken_on DESC) WHERE outcome IS NULL;

-- what the decision rested on: documents, and sources that are not documents
CREATE TABLE decision_evidence (
  decision_evidence_id bigserial PRIMARY KEY,
  decision_id bigint  NOT NULL REFERENCES decision (decision_id) ON DELETE CASCADE,
  document_id bigint  REFERENCES document (document_id),
  source_url  text,
  note        text,
  CONSTRAINT evidence_points_somewhere
    CHECK (document_id IS NOT NULL OR source_url IS NOT NULL)
);

CREATE INDEX idx_decision_evidence ON decision_evidence (decision_id);
