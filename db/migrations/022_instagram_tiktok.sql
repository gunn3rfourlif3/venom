-- Instagram and TikTok, recorded as they actually are in October 2026.
--
-- TIKTOK IS CLOSED, on two counts rather than one.
--   The Research API requires applicants to "be independent of commercial
--   interests" and to work on a not-for-profit or non-commercial basis, so a
--   campaign is excluded outright. Separately, eligibility is limited to
--   academic institutions in the US, EEA, UK, Canada and Switzerland, plus a
--   Brazilian carve-out for online youth safety. South Africa is not an
--   eligible applicant region at all.
--   The Commercial Content API is open to the public, but its data covers
--   ONLY EU countries. There is no Gauteng in it.
--   So both doors are shut, and this row exists so nobody opens the question
--   a third time.
--
-- INSTAGRAM IS CONDITIONAL, not open.
--   Hashtag Search is real and works, but it needs a Business or Creator
--   account, App Review for the Instagram Public Content Access feature and
--   the instagram_basic permission, and it is capped at THIRTY unique
--   hashtags per account per rolling seven days. A hashtag counts from its
--   first query and the clock does not reset. That cap is the binding
--   constraint on the whole design: there is no sweeping eleven
--   municipalities by eight categories here, so the hashtags are a small
--   curated list, held as data, with the quota tracked.
--
--   It also returns `username`. Venom does not want it, does not ask for it,
--   and the adapter requests an explicit field list that excludes it. The
--   issues-not-people boundary is the same one as everywhere else, and this
--   is the source most likely to breach it by accident.

INSERT INTO source (source_id, label, kind, access, base_url, terms_url,
                    notes, measures, enabled) VALUES

('instagram', 'Instagram hashtag search', 'SOCIAL', 'KEYED',
 'https://graph.facebook.com/v21.0', 'https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/hashtag-search',
 'Needs a Business or Creator account plus App Review for Instagram Public '
 'Content Access and instagram_basic. Capped at 30 unique hashtags per '
 'account per rolling 7 days, counted from first query, which is why the '
 'hashtags are a curated list rather than a sweep. Returns username; the '
 'adapter does not request it and never stores it.',
 'how much a hashtag is being posted under, in places the hashtag itself names',
 false),

('tiktok', 'TikTok', 'SOCIAL', 'CLOSED',
 NULL, 'https://developers.tiktok.com/products/research-api/',
 'No route in. The Research API requires applicants to be independent of '
 'commercial interests and limits eligibility to academic institutions in '
 'the US, EEA, UK, Canada and Switzerland - South Africa is not an eligible '
 'region and a campaign is not an eligible applicant. The Commercial Content '
 'API is open to anyone but carries EU data only, so it holds nothing about '
 'Gauteng. Recorded as CLOSED so this is not re-investigated.',
 NULL, false);

-- The curated hashtags, and the quota ledger, in one table.
--
-- Both jobs in one place on purpose: the thirty-per-seven-days cap is a
-- property of the list, and splitting the list from the counter is how a
-- team ends up burning its quota on a hashtag someone added and forgot.
CREATE TABLE instagram_hashtag (
  tag              text PRIMARY KEY CHECK (tag ~ '^[A-Za-z0-9_]+$'),

  -- Geography comes from the hashtag's own meaning and nothing else.
  -- Instagram hashtag media carries no reliable location, so a tag that does
  -- not name a place cannot be attributed to one. Those are held here with a
  -- null municipality and are not ingested - recorded rather than guessed.
  demarcation_code text REFERENCES municipality (demarcation_code),
  category         issue_category,

  -- Resolved once and kept: looking up the id costs a query against the cap.
  hashtag_id       text,

  last_queried_at  timestamptz,
  last_media_count integer CHECK (last_media_count >= 0),
  enabled          boolean NOT NULL DEFAULT true,
  note             text
);

COMMENT ON TABLE instagram_hashtag IS
  'Curated hashtags and the 30-per-7-days quota ledger. A tag with no '
  'demarcation_code names no place and is not ingested.';

/* A seed of tags that do name a Gauteng municipality. Deliberately short:
   the cap is thirty and these must earn their place. demarcation_code is
   left to be filled once municipalities are loaded, because this migration
   must not fail on a database that has not run sources:official yet. */
INSERT INTO instagram_hashtag (tag, category, note) VALUES
  ('JoburgWater',     'Water',       'City of Johannesburg, names the utility'),
  ('CityPowerJHB',    'Electricity', 'City of Johannesburg, names the utility'),
  ('JoburgPotholes',  'Roads',       'City of Johannesburg'),
  ('PikitupJoburg',   'Refuse',      'City of Johannesburg, names the utility'),
  ('TshwaneWater',    'Water',       'City of Tshwane'),
  ('EkurhuleniWater', 'Water',       'City of Ekurhuleni'),
  ('EmfuleniSewage',  'Sanitation',  'Emfuleni, the long-running story'),
  -- Named but unattributable: real and relevant, no municipality in the tag.
  ('loadshedding',    'Electricity', 'Province-wide at best; names no municipality'),
  ('servicedelivery', NULL,          'Names neither a place nor one service');

UPDATE instagram_hashtag SET demarcation_code = 'JHB'
 WHERE tag IN ('JoburgWater', 'CityPowerJHB', 'JoburgPotholes', 'PikitupJoburg')
   AND EXISTS (SELECT 1 FROM municipality WHERE demarcation_code = 'JHB');
UPDATE instagram_hashtag SET demarcation_code = 'TSH'
 WHERE tag = 'TshwaneWater'
   AND EXISTS (SELECT 1 FROM municipality WHERE demarcation_code = 'TSH');
UPDATE instagram_hashtag SET demarcation_code = 'EKU'
 WHERE tag = 'EkurhuleniWater'
   AND EXISTS (SELECT 1 FROM municipality WHERE demarcation_code = 'EKU');
UPDATE instagram_hashtag SET demarcation_code = 'GT421'
 WHERE tag = 'EmfuleniSewage'
   AND EXISTS (SELECT 1 FROM municipality WHERE demarcation_code = 'GT421');

-- Tags that name no place are kept for the record and switched off, so the
-- quota is never spent on something that cannot be attributed.
UPDATE instagram_hashtag SET enabled = false WHERE demarcation_code IS NULL;
