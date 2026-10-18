-- location — anywhere stock can sit.
--
-- Replaces the 'CENTRAL' sentinel that was carried in asset_holding.ward_id.
-- A magic string in a foreign key column cannot be constrained and leaks into
-- every query as a WHERE ward_id <> 'CENTRAL' filter. A location table with a
-- kind generalises to the several depots a provincial campaign will actually
-- run, and matches the 'location' column v_asset_available already emits.

CREATE TYPE location_kind AS ENUM ('ward', 'depot', 'central');

CREATE TABLE location (
  location_id  text          PRIMARY KEY,
  kind         location_kind NOT NULL,
  name         text          NOT NULL,

  -- set when kind = 'ward'; null otherwise. The FK is added in 004 once
  -- ward exists, to keep the migration order acyclic.
  ward_id      text,

  CONSTRAINT ward_kind_has_ward_id
    CHECK ((kind = 'ward') = (ward_id IS NOT NULL))
);

INSERT INTO location (location_id, kind, name)
VALUES ('CENTRAL', 'central', 'Central store');
