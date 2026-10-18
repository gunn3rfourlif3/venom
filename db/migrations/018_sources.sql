-- Where the numbers come from, what each source is allowed to give us, and
-- what it cost to ask.
--
-- WHY A REGISTRY AND NOT A CONFIG FILE. Three of the named sources are
-- constrained by someone else's terms rather than by our code: X meters every
-- post read, Reddit requires an identified OAuth client, and Meta's Content
-- Library is restricted to not-for-profit research institutions, which a
-- campaign is not. Those constraints decide what the pipeline may keep, so
-- they belong in the schema beside the data, not in a comment someone
-- forgets. `stores_text` is the one that matters: for every social source it
-- is false, and nothing in this database has a column to put a post in.
--
-- THE BOUNDARY, RESTATED. Scoring happens in memory. Posts are fetched,
-- classified, counted, and dropped. What reaches disk is a count and a score
-- per ward, per category, per day (issue_signal, migration 017). There is no
-- table here that could hold a handle, a quote or an author, and that is
-- deliberate: the way this kind of system goes wrong is that someone keeps
-- the raw text "just for debugging" and it never leaves.

CREATE TYPE source_kind AS ENUM (
  'SOCIAL',      -- public posts, aggregated before storage
  'OFFICIAL',    -- government or treasury publication
  'SURVEY',      -- sampled microdata under licence
  'REFERENCE');  -- lookup tables, boundaries, names

-- How we are allowed to get at it. This drives the Sources screen and the
-- scheduler: OPEN can run unattended, METERED needs a budget, LICENSED and
-- CLOSED cannot be automated at all.
CREATE TYPE source_access AS ENUM (
  'OPEN',       -- public endpoint, no credential
  'KEYED',      -- free but requires a registered client
  'METERED',    -- billed per call or per item returned
  'LICENSED',   -- manual download under a licence agreement
  'CLOSED');    -- not available to us; recorded so nobody re-litigates it

CREATE TABLE source (
  source_id    text          PRIMARY KEY,
  label        text          NOT NULL,
  kind         source_kind   NOT NULL,
  access       source_access NOT NULL,
  base_url     text,
  terms_url    text,

  -- False for every SOCIAL source, and there is no column anywhere in this
  -- schema that would hold the text if it were true.
  stores_text  boolean       NOT NULL DEFAULT false,

  -- Why this source is in the state it is in. Required, because an access
  -- level without a reason gets quietly changed by the next person.
  notes        text          NOT NULL,

  enabled      boolean       NOT NULL DEFAULT false,
  last_ok_at       timestamptz,
  last_attempt_at  timestamptz,
  last_error       text,

  CONSTRAINT social_is_aggregate_only
    CHECK (kind <> 'SOCIAL' OR stores_text = false),
  CONSTRAINT closed_cannot_be_enabled
    CHECK (access <> 'CLOSED' OR enabled = false)
);

COMMENT ON CONSTRAINT social_is_aggregate_only ON source IS
  'Social listening keeps counts, never posts. Enforced here so that turning '
  'it on requires changing the schema, not a flag.';

-- One row per fetch attempt. cost_usd exists because X bills per post
-- returned: a campaign that cannot see what its listening cost will keep
-- listening until the invoice arrives.
CREATE TABLE source_run (
  source_run_id bigserial   PRIMARY KEY,
  source_id     text        NOT NULL REFERENCES source (source_id),
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  ok            boolean,
  items_seen    integer     CHECK (items_seen  >= 0),
  items_kept    integer     CHECK (items_kept  >= 0),
  cost_usd      numeric(10,4) CHECK (cost_usd >= 0),
  error         text,
  CONSTRAINT kept_within_seen
    CHECK (items_kept IS NULL OR items_seen IS NULL OR items_kept <= items_seen)
);

CREATE INDEX idx_source_run_source ON source_run (source_id, started_at DESC);

-- The municipality dimension, keyed by the Municipal Demarcation Board code
-- that National Treasury uses. Venom is ward-level; every source below is
-- municipality-level and annual. This table is the join that makes the
-- difference explicit rather than letting municipality-wide figures be read
-- as if they described a ward.
CREATE TABLE municipality (
  demarcation_code text    PRIMARY KEY,
  name             text    NOT NULL UNIQUE,
  category         char(1) CHECK (category IN ('A','B','C')),
  province_code    text,
  province_name    text,
  retrieved_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE municipality IS
  'MDB demarcation codes, loaded from the National Treasury Municipal Money '
  'API. ward.municipality joins to name.';

-- Service delivery and municipal finance, as published. Annual and
-- municipality-wide: this is CONTEXT for a ward, never a ward measurement.
CREATE TABLE service_fact (
  service_fact_id  bigserial PRIMARY KEY,
  source_id        text      NOT NULL REFERENCES source (source_id),
  demarcation_code text      NOT NULL REFERENCES municipality (demarcation_code),

  financial_year   integer   NOT NULL CHECK (financial_year BETWEEN 2000 AND 2100),

  -- Free text rather than an enum: the publishers add and rename measures
  -- every year, and an enum would turn their housekeeping into a migration.
  metric           text      NOT NULL,

  -- Set where a metric lines up with a grievance category, so the sentiment
  -- screen can put complaints beside the service they are about. Null where
  -- it does not line up, which is most financial measures.
  category         issue_category,

  value            numeric   NOT NULL,
  unit             text      NOT NULL,   -- 'households' | 'ZAR' | 'ratio' | 'count'

  -- What the publisher called it, kept verbatim so a figure can be traced
  -- back to the table it came out of.
  publisher_label  text,
  source_url       text,
  retrieved_at     timestamptz NOT NULL DEFAULT now(),

  UNIQUE (source_id, demarcation_code, financial_year, metric)
);

CREATE INDEX idx_service_fact_muni ON service_fact (demarcation_code, financial_year DESC);
CREATE INDEX idx_service_fact_cat  ON service_fact (category, financial_year DESC)
  WHERE category IS NOT NULL;

COMMENT ON TABLE service_fact IS
  'Municipality-level annual facts from official publications. Context for a '
  'ward, not a measurement of one.';

-- The registry as it actually stands in October 2026. Each access level was
-- checked against the publisher's own documentation, not assumed.
INSERT INTO source (source_id, label, kind, access, base_url, terms_url, notes, enabled) VALUES

('x', 'X (Twitter)', 'SOCIAL', 'METERED',
 'https://api.x.com/2', 'https://docs.x.com/x-api/getting-started/pricing',
 'Pay-per-use credits, no subscription tier. Reads bill at USD 0.005 per post '
 'returned, so ten thousand posts is about USD 50. The same resource re-fetched '
 'within a UTC day is charged once. Every run must record cost_usd.', false),

('reddit', 'Reddit', 'SOCIAL', 'KEYED',
 'https://oauth.reddit.com', 'https://support.reddithelp.com/hc/en-us/articles/16160319875092',
 'Free, but OAuth is mandatory and unidentified traffic is blocked outright. '
 '100 queries per minute per client ID, averaged over ten minutes. User-Agent '
 'must be <platform>:<app id>:<version> (by /u/<username>). Commercial use is '
 'governed by the Data API Terms - read them before this is switched on.', false),

('facebook', 'Facebook / Meta', 'SOCIAL', 'CLOSED',
 NULL, 'https://developers.facebook.com/docs/content-library-and-api/get-access',
 'No route in. CrowdTangle was shut down in August 2024. Its replacement, the '
 'Meta Content Library, requires affiliation with an accredited not-for-profit '
 'academic or research institution whose core activity is scientific or public '
 'interest research; a campaign does not qualify. The Graph API does not expose '
 'public post search. Recorded as CLOSED so this is not re-investigated.', false),

('municipal_money', 'National Treasury Municipal Money', 'OFFICIAL', 'OPEN',
 'https://municipaldata.treasury.gov.za/api', 'https://municipalmoney.gov.za/',
 'Open JSON API, no credential, Babbage/Cubes query syntax. Financial cubes '
 'only - income and expenditure, capital, repairs and maintenance, audit '
 'opinions, debtors, UIFW. Also the authoritative municipality list with MDB '
 'demarcation codes, which is what municipality is loaded from.', true),

('statssa_p9115', 'Stats SA Non-Financial Census of Municipalities', 'OFFICIAL', 'LICENSED',
 'https://www.statssa.gov.za/publications/P9115/', NULL,
 'The actual service delivery counts: households receiving water, electricity, '
 'refuse removal and sewerage, per municipality, per year. Published annually '
 'as PDF and spreadsheet with no API, so it is loaded by hand and stamped with '
 'the release it came from. This is the closest thing to a ground truth the '
 'sentiment screen has.', false),

('datafirst', 'DataFirst (UCT)', 'SURVEY', 'LICENSED',
 'https://www.datafirst.uct.ac.za/dataportal/', NULL,
 'NADA microdata catalogue - General Household Survey, Census, QLFS. '
 'Registration and a licence agreement per dataset; robots.txt disallows '
 'automated access to the catalogue API, so this is a manual download that '
 'someone loads deliberately. Sampled survey data: representative at province '
 'and sometimes municipality level, never at ward level.', false),

('municipalities_co_za', 'municipalities.co.za', 'REFERENCE', 'OPEN',
 'https://municipalities.co.za', 'https://municipalities.co.za/robots.txt',
 'No API. robots.txt permits the content paths and disallows only /uploads/, '
 '/files/, /exports/ and /admin/. Useful for municipality reference details '
 'and nothing else. Crawl slowly, cache hard, and re-read robots before each '
 'run - a third-party directory is not a dependency worth hammering.', false),

('SYNTHETIC', 'Synthetic development data', 'REFERENCE', 'OPEN',
 NULL, NULL,
 'Generated for development. Describes no real place and no real opinion. '
 'The sentiment screen reads this source id to raise its banner.', true);
