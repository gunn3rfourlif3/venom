-- station — voting stations within a ward.
--
-- The station list, coordinates and registration figures are scraped.
-- our_people, hours_coverage, anc_expected and pledges are reported by
-- whoever is at the station, so they carry audit columns: this is one of the
-- two tables where a timestamped write by an identified person is what makes
-- the figure defensible.

CREATE TABLE station (
  station_id         text         PRIMARY KEY,
  ward_id            text         NOT NULL REFERENCES ward (ward_id),
  name               text         NOT NULL,
  registered_voters  integer      CHECK (registered_voters >= 0),
  latitude           numeric(9,6),
  longitude          numeric(9,6),

  -- reported on the day
  our_people         integer      NOT NULL DEFAULT 0 CHECK (our_people >= 0),
  hours_coverage     numeric(5,2) NOT NULL DEFAULT 0 CHECK (hours_coverage >= 0),
  anc_expected       integer      NOT NULL DEFAULT 0 CHECK (anc_expected >= 0),
  pledges            integer      NOT NULL DEFAULT 0 CHECK (pledges >= 0),

  -- provenance for the scraped columns
  source             text,
  source_fetched_at  timestamptz,
  source_url         text,

  -- audit for the reported columns
  reported_by        text         REFERENCES app_user (user_id),
  reported_at        timestamptz
);

CREATE INDEX idx_station_ward ON station (ward_id);
