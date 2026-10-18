-- deployment — a planned action in a ward on a date.
--
-- v_deployment_feasibility tests each row against ward capacity and the
-- asset pool before any money is committed.

CREATE TABLE deployment (
  deployment_id      bigserial   PRIMARY KEY,
  ward_id            text        NOT NULL REFERENCES ward (ward_id),
  deploy_date        date        NOT NULL,
  action_type        text        NOT NULL,

  kitted_soldiers    integer     NOT NULL DEFAULT 0 CHECK (kitted_soldiers >= 0),
  tshirts_drawn      integer     NOT NULL DEFAULT 0 CHECK (tshirts_drawn >= 0),
  catering_headcount integer     NOT NULL DEFAULT 0 CHECK (catering_headcount >= 0),
  transport_bodies   integer     NOT NULL DEFAULT 0 CHECK (transport_bodies >= 0),

  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_deployment_ward ON deployment (ward_id);
CREATE INDEX idx_deployment_date ON deployment (deploy_date);
