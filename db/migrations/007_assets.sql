-- asset_holding and liquidatable — what exists to deploy.
--
-- asset_holding now hangs off location rather than carrying a 'CENTRAL'
-- sentinel in a ward_id column. liquidatable's strategic_destination is a
-- location for the same reason.

CREATE TYPE asset_status AS ENUM ('Available', 'Committed', 'Deployed', 'Written off');

CREATE TABLE asset_holding (
  asset_holding_id  bigserial    PRIMARY KEY,
  location_id       text         NOT NULL REFERENCES location (location_id),
  asset_type        text         NOT NULL,
  quantity          integer      NOT NULL CHECK (quantity >= 0),
  status            asset_status NOT NULL DEFAULT 'Available',
  noted_at          timestamptz  NOT NULL DEFAULT now(),

  UNIQUE (location_id, asset_type, status)
);

CREATE INDEX idx_asset_holding_type ON asset_holding (asset_type, status);

-- Resources that can be converted before any of our own stock is spent.
-- assessed_value and fetch_cost are what make the arbitrage order real:
-- anything whose fetch cost exceeds its assessed value is not an asset.
CREATE TABLE liquidatable (
  liquidatable_id        bigserial     PRIMARY KEY,
  resource_type          text          NOT NULL,
  quantity               integer       NOT NULL CHECK (quantity >= 0),
  assessed_value         numeric(12,2) NOT NULL CHECK (assessed_value >= 0),
  fetch_cost             numeric(12,2) NOT NULL DEFAULT 0 CHECK (fetch_cost >= 0),
  strategic_destination  text          NOT NULL REFERENCES location (location_id),
  status                 asset_status  NOT NULL DEFAULT 'Available',
  noted_at               timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX idx_liquidatable_type ON liquidatable (resource_type, status);
