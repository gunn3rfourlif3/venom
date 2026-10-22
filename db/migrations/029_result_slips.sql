-- result slips — the only data that cannot be collected after election night.
--
-- Everything else in Xnith can be rebuilt the next morning: the register comes
-- from the IEC, logistics from the reports already filed, results from the
-- IEC declaration once it publishes. The station-level count written on the
-- slip taped to the door at 23:00 is different. It is posted publicly for a
-- few hours, photographed or not, and then it is gone. If the party's own
-- count disagrees with the declared one later, this table is the only thing
-- that can say so.
--
-- BALLOTS PER STATION IS NOT ONE.
-- Confirmed against the published description of local government elections:
--   category A (metro)              2 ballots: ward + municipal PR
--   category B (local municipality) 3 ballots: ward + municipal PR + district PR
-- The register holds 5,070 stations in category A and 18,681 in category B, so
-- a capture flow that accepts "the slip" for a station would silently lose two
-- of every three counts across most of the country. Marshals must be told which
-- slip they are photographing, and the coverage view must count each ballot
-- separately. This is the same class of fault as SUPPLY_OK in 028: a default
-- that quietly means "fine" over rows that have no data.

CREATE TYPE ballot_type AS ENUM ('WARD', 'PR_MUNICIPAL', 'PR_DISTRICT');

-- ---------------------------------------------------------------------------
-- The photograph.
-- ---------------------------------------------------------------------------
CREATE TABLE result_slip (
  slip_id      bigserial    PRIMARY KEY,
  station_id   text         NOT NULL REFERENCES station (station_id),
  ballot       ballot_type  NOT NULL,

  -- Where the image sits in the slip store, relative to its root. The bytes
  -- never go in the database: a night of photographs is gigabytes, and a
  -- 3GB-limited Postgres container is not where they belong.
  image_path   text         NOT NULL,
  image_sha256 text         NOT NULL,
  image_bytes  integer      NOT NULL CHECK (image_bytes > 0),

  captured_at  timestamptz  NOT NULL DEFAULT now(),
  captured_by  text         REFERENCES reporter_roster (phone),

  -- A marshal may photograph the same slip twice — the first one blurred, or
  -- taken before the presiding officer signed it. Both are kept; the newest
  -- usable one is current (see v_slip_current). Nothing is overwritten,
  -- because the superseded photograph is still evidence of what was on the
  -- door at the time it was taken.
  superseded   boolean      NOT NULL DEFAULT false,
  rejected     text,                     -- why an operator discarded it, if so

  status       text         NOT NULL DEFAULT 'PENDING'
                 CHECK (status IN ('PENDING', 'TRANSCRIBED', 'VERIFIED', 'DISPUTED'))
);

CREATE INDEX idx_slip_station ON result_slip (station_id, ballot);
CREATE INDEX idx_slip_pending ON result_slip (status) WHERE status = 'PENDING';

COMMENT ON TABLE result_slip IS
  'A photograph of an IEC result slip posted at a voting station. One row per '
  'photograph, not per station: category B stations produce three slips.';

-- ---------------------------------------------------------------------------
-- The transcription — entered twice, by two people, on purpose.
-- ---------------------------------------------------------------------------
--
-- Single-keyed numbers off a photograph of a handwritten form at two in the
-- morning will contain errors, and an error here is indistinguishable from
-- the fraud this table exists to detect. Two independent passes that agree are
-- evidence; two that disagree are a flag, not a result. The cost is double the
-- typing, which is the cheapest part of the night.
CREATE TABLE result_transcription (
  transcription_id bigserial   PRIMARY KEY,
  slip_id          bigint      NOT NULL REFERENCES result_slip (slip_id),
  pass             smallint    NOT NULL CHECK (pass IN (1, 2)),
  entered_by       text        NOT NULL,
  entered_at       timestamptz NOT NULL DEFAULT now(),

  -- Off the foot of the slip. These are what reconcile the party lines:
  -- the party votes plus spoilt should equal total votes cast.
  spoilt           integer     CHECK (spoilt >= 0),
  total_votes_cast integer     CHECK (total_votes_cast >= 0),

  UNIQUE (slip_id, pass)
);

CREATE TABLE result_vote (
  transcription_id bigint  NOT NULL REFERENCES result_transcription (transcription_id)
                             ON DELETE CASCADE,
  party            text    NOT NULL,
  votes            integer NOT NULL CHECK (votes >= 0),
  PRIMARY KEY (transcription_id, party)
);

-- A transcription is a record of what someone read off a photograph at a
-- moment. Correcting it means entering it again, not editing history — the
-- same rule as booth_report in 025. Without this, a disagreement between two
-- passes could be resolved by quietly changing one of them, which defeats the
-- entire point of entering it twice.
CREATE OR REPLACE FUNCTION result_transcription_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'result_transcription is append-only: enter a further pass instead of % ',
    TG_OP;
END $$;

CREATE TRIGGER trg_transcription_append_only
  BEFORE UPDATE OR DELETE ON result_transcription
  FOR EACH ROW EXECUTE FUNCTION result_transcription_append_only();

-- ---------------------------------------------------------------------------
-- What should exist.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_slip_expected AS
SELECT s.station_id,
       w.ward_id,
       w.municipality,
       w.province,
       m.category,
       b.ballot
  FROM station s
  JOIN ward w          ON w.ward_id = s.ward_id
  JOIN municipality m  ON m.demarcation_code = w.demarcation_code
  CROSS JOIN LATERAL (
    SELECT unnest(
      CASE m.category
        WHEN 'A' THEN ARRAY['WARD', 'PR_MUNICIPAL']::ballot_type[]
        WHEN 'B' THEN ARRAY['WARD', 'PR_MUNICIPAL', 'PR_DISTRICT']::ballot_type[]
        ELSE ARRAY[]::ballot_type[]
      END) AS ballot
  ) b;

COMMENT ON VIEW v_slip_expected IS
  'One row per slip that should be photographed. Category decides how many: '
  'two in a metro, three in a local municipality.';

-- The newest usable photograph for each expected slip.
CREATE OR REPLACE VIEW v_slip_current AS
SELECT DISTINCT ON (station_id, ballot)
       slip_id, station_id, ballot, image_path, image_sha256,
       captured_at, captured_by, status
  FROM result_slip
 WHERE NOT superseded AND rejected IS NULL
 ORDER BY station_id, ballot, captured_at DESC;

-- ---------------------------------------------------------------------------
-- Where the two passes disagree. This is the screen that matters at 02:00.
-- ---------------------------------------------------------------------------
-- The party list is built from BOTH passes before either is joined. Hanging
-- the match off pass 1 would mean a party only pass 2 typed produces no row
-- at all — and a missed line is precisely the error double entry is for. With
-- the union, the absent side reads NULL and IS DISTINCT FROM flags it.
CREATE OR REPLACE VIEW v_slip_disagreement AS
WITH pass AS (
  SELECT t.slip_id, t.pass, v.party, v.votes
    FROM result_transcription t
    JOIN result_vote v USING (transcription_id)
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

-- Does the slip add up? Party votes plus spoilt should equal total cast. A
-- slip that does not reconcile is either mis-transcribed or wrong on the door,
-- and both are worth knowing before the declaration.
CREATE OR REPLACE VIEW v_slip_reconciliation AS
SELECT t.transcription_id,
       s.station_id,
       s.ballot,
       t.pass,
       sum(v.votes)                                   AS party_total,
       t.spoilt,
       t.total_votes_cast,
       sum(v.votes) + COALESCE(t.spoilt, 0)
         - t.total_votes_cast                         AS discrepancy
  FROM result_transcription t
  JOIN result_slip s USING (slip_id)
  JOIN result_vote v USING (transcription_id)
 GROUP BY t.transcription_id, s.station_id, s.ballot, t.pass,
          t.spoilt, t.total_votes_cast;

-- ---------------------------------------------------------------------------
-- Coverage, by municipality. Counted per ballot, never per station.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_slip_coverage AS
SELECT e.province,
       e.municipality,
       count(*)                                           AS slips_expected,
       count(c.slip_id)                                   AS photographed,
       count(*) FILTER (WHERE c.status = 'VERIFIED')       AS verified,
       count(*) - count(c.slip_id)                        AS outstanding,
       round(100.0 * count(c.slip_id) / NULLIF(count(*), 0), 1) AS pct_photographed
  FROM v_slip_expected e
  LEFT JOIN v_slip_current c
         ON c.station_id = e.station_id AND c.ballot = e.ballot
 GROUP BY e.province, e.municipality;
