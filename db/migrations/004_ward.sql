-- ward — the unit of account.
--
-- Electoral columns are scraped from the IEC API and carry provenance.
-- The m1-m5 capacity columns are reported by zone organisers and carry none,
-- because they are claims rather than facts; v_ward_reliability exists to
-- discount them.
--
-- NOTE ON NUMBERING: the original design ran m1, m2, m3, m5, m6 with no m4.
-- Renumbered contiguous here. The m-prefix shorthand is kept deliberately
-- because it is the campaign's own vocabulary; descriptive names are the
-- alternative if that shorthand is not in use outside the schema.

CREATE TABLE ward (
  ward_id              text         PRIMARY KEY,
  municipality         text         NOT NULL,
  zone                 text,
  province             text         NOT NULL DEFAULT 'Gauteng',

  -- electoral baseline, scraped
  registered_voters    integer      NOT NULL CHECK (registered_voters >= 0),
  t2021_anc            integer      CHECK (t2021_anc >= 0),
  t2024_mkp            integer      CHECK (t2024_mkp >= 0),
  t2024_anc            integer      CHECK (t2024_anc >= 0),
  t2024_turnout        numeric(5,2) CHECK (t2024_turnout >= 0 AND t2024_turnout <= 100),

  -- Highest turnout this ward has recorded, carried on BOTH bases so either
  -- can be read without a rebuild. Derived during promotion from past
  -- results, never keyed by hand.
  --   _lge  peak across local government elections only
  --   _all  peak across all elections, national and provincial included
  -- Local turnout runs well below national, so _all sets a ceiling a
  -- municipal election will not reach. control_panel.peak_basis picks which
  -- one drives the EO arithmetic; v_ward_computed exposes both regardless.
  peak_turnout_lge_pct numeric(5,2) CHECK (peak_turnout_lge_pct >= 0 AND peak_turnout_lge_pct <= 100),
  peak_turnout_all_pct numeric(5,2) CHECK (peak_turnout_all_pct >= 0 AND peak_turnout_all_pct <= 100),

  CONSTRAINT all_peak_not_below_lge_peak
    CHECK (peak_turnout_all_pct IS NULL
           OR peak_turnout_lge_pct IS NULL
           OR peak_turnout_all_pct >= peak_turnout_lge_pct),

  -- campaign state
  candidate_status     text         NOT NULL DEFAULT 'None'
                       CHECK (candidate_status IN ('None', 'Pending', 'Confirmed')),

  -- reported capacity (claims, not measurements)
  m1_weekday           integer      CHECK (m1_weekday >= 0),            -- any-day bodies claimed
  m2_weekend           integer      CHECK (m2_weekend >= 0),            -- weekend-only bodies claimed
  m3_last_actual       integer      CHECK (m3_last_actual >= 0),        -- bodies that actually turned out last time
  m4_transport_required integer     CHECK (m4_transport_required >= 0), -- bodies needing transport
  m5_confidence        smallint     CHECK (m5_confidence BETWEEN 1 AND 5),

  -- provenance for the scraped columns
  source               text,
  source_fetched_at    timestamptz,
  source_url           text
);

CREATE INDEX idx_ward_municipality ON ward (municipality);
CREATE INDEX idx_ward_zone         ON ward (zone);

-- Deferred foreign keys: both tables were created before ward existed.
ALTER TABLE location
  ADD CONSTRAINT location_ward_fk FOREIGN KEY (ward_id) REFERENCES ward (ward_id);

ALTER TABLE iec_result
  ADD CONSTRAINT iec_result_ward_fk FOREIGN KEY (ward_id) REFERENCES ward (ward_id);
