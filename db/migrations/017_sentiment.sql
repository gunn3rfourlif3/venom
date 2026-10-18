-- Sentiment signal: how an area is reacting to its grievances, over time.
--
-- WHAT THIS IS. An AGGREGATE feed: counts and a score per ward, per
-- category, per day, from a named source. It is not a store of posts, and
-- it never holds an author, a handle, a quote or anything identifying.
-- The issues-not-people boundary from migration 013 applies in full here -
-- this table is the one most likely to drift across it, because the
-- obvious way to build sentiment analysis is to keep the text. Do not.
--
-- WHAT IT IS NOT. net_sentiment is a classifier's output with a stated
-- confidence and a named source, not a measurement and not an opinion.
-- It is only as good as the feed behind it, and it currently has none:
-- every row today is synthetic (source = 'SYNTHETIC'). Treat a score
-- without a source you trust as decoration.
--
-- tone is deliberately an ORDINAL about disposition, not a polarity.
-- For a campaign the operative question is not whether a ward is unhappy -
-- they are nearly all unhappy - but whether that unhappiness is inert or
-- moving. Resigned and Mobilising are both "negative"; only one of them
-- changes turnout.

CREATE TYPE sentiment_tone AS ENUM ('Resigned', 'Frustrated', 'Angry', 'Mobilising');

CREATE TABLE issue_signal (
  issue_signal_id bigserial      PRIMARY KEY,
  ward_id         text           NOT NULL REFERENCES ward (ward_id),
  category        issue_category NOT NULL,
  observed_on     date           NOT NULL,

  -- volume of public reports attributed to this ward and category
  mentions        integer        NOT NULL CHECK (mentions >= 0),

  -- -1 wholly negative, +1 wholly positive, 0 mixed
  net_sentiment   numeric(4,3)   NOT NULL
                  CHECK (net_sentiment >= -1 AND net_sentiment <= 1),

  tone            sentiment_tone NOT NULL,

  -- provenance, as everywhere else in this schema
  source          text           NOT NULL,
  source_url      text,
  confidence      numeric(4,3)   CHECK (confidence >= 0 AND confidence <= 1),
  ingested_at     timestamptz    NOT NULL DEFAULT now(),

  UNIQUE (ward_id, category, observed_on, source)
);

CREATE INDEX idx_signal_ward     ON issue_signal (ward_id, observed_on DESC);
CREATE INDEX idx_signal_category ON issue_signal (category, observed_on DESC);
CREATE INDEX idx_signal_date     ON issue_signal (observed_on DESC);

COMMENT ON TABLE issue_signal IS
  'Aggregate sentiment per ward, category and day. Counts and scores only: '
  'never posts, authors, handles or quotes.';

-- How far back the sentiment screen looks, and where the bands fall.
ALTER TABLE control_panel
  ADD COLUMN sentiment_window_days integer NOT NULL DEFAULT 56
    CHECK (sentiment_window_days BETWEEN 7 AND 365),
  ADD COLUMN sentiment_strong_at   numeric(4,3) NOT NULL DEFAULT 0.600
    CHECK (sentiment_strong_at > 0 AND sentiment_strong_at <= 1),
  ADD COLUMN sentiment_mixed_at    numeric(4,3) NOT NULL DEFAULT 0.200
    CHECK (sentiment_mixed_at > 0 AND sentiment_mixed_at <= 1),
  ADD CONSTRAINT sentiment_bands_ordered
    CHECK (sentiment_strong_at > sentiment_mixed_at);
