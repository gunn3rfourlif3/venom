-- Local community newspapers.
--
-- WHY THIS INSTEAD OF SCRAPING A PLATFORM. The thing a campaign actually
-- wants from social listening is local grievance at a fine enough geography
-- to act on. A TikTok hashtag gives neither: no reliable location, and the
-- tag is usually province-wide at best. These titles cover single suburbs -
-- Pimville, Katlehong, Meyerton, Ga-Rankuwa - and publish an open RSS feed
-- that asks nothing of anyone. For the question being asked, that is a
-- better instrument, not a consolation prize.
--
-- They also carry Afrikaans (Vaal Weekblad, Heidelberg/Nigel Heraut), which
-- goes a small way toward the language gap in the scorer: the lexicon is
-- English and the wards that are not are currently under-measured.
--
-- WHAT IT MEASURES. Local press attention to a service in an area. Still not
-- public opinion. Closer to the ground than national coverage, and nothing
-- here is anyone's private post.
--
-- WHAT IT CANNOT DO. Each feed returns only the ten most recent items, so
-- there is no backfill. A time series exists only from the first run
-- onwards, which is an argument for running it daily and no argument at all
-- for pretending otherwise.

INSERT INTO source (source_id, label, kind, access, base_url, terms_url,
                    notes, measures, enabled) VALUES
('local_press', 'Gauteng community newspapers', 'OFFICIAL', 'OPEN',
 NULL, NULL,
 'Open RSS from twenty-one local titles covering ten of the eleven '
 'ward-holding municipalities. Suburb-level coverage, which is finer than '
 'any social platform offers for this question. Each feed carries only its '
 'ten latest items, so there is no history before the first run - it must be '
 'run regularly to build a series. Headlines are counted and scored, never '
 'stored.',
 'how much local press attention a service is getting in an area',
 true);

CREATE TABLE press_title (
  domain           text PRIMARY KEY,
  label            text NOT NULL,
  -- Deliberately not a foreign key. This mapping is editorial and fixed -
  -- the Randburg Sun covers Johannesburg whether or not anyone has loaded
  -- Johannesburg yet - while the municipality table is populated later by
  -- sources:official. A foreign key here makes a fresh clone unmigratable:
  -- the schema would refuse to build until real data had been fetched,
  -- which is backwards. The join in enabledTitles() is the real gate; a
  -- title whose municipality is absent simply does not come back.
  demarcation_code text,
  -- Afrikaans titles are kept and marked: the scorer is weakest on them and
  -- that weakness should be visible rather than buried in a low score.
  language         text NOT NULL DEFAULT 'en',
  enabled          boolean NOT NULL DEFAULT true,
  last_fetched_at  timestamptz,
  last_item_count  integer CHECK (last_item_count >= 0)
);

COMMENT ON TABLE press_title IS
  'Community newspaper RSS feeds, one row per title, mapped to the '
  'municipality that title covers.';

INSERT INTO press_title (domain, label, demarcation_code, language) VALUES
  -- City of Johannesburg
  ('roodepoortrecord.co.za',        'Roodepoort Record',           'JHB', 'en'),
  ('sowetourban.co.za',             'Soweto Urban',                'JHB', 'en'),
  ('randburgsun.co.za',             'Randburg Sun',                'JHB', 'en'),
  ('sandtonchronicle.co.za',        'Sandton Chronicle',           'JHB', 'en'),
  ('fourwaysreview.co.za',          'Fourways Review',             'JHB', 'en'),
  ('northcliffmelvilletimes.co.za', 'Northcliff Melville Times',   'JHB', 'en'),
  ('alexnews.co.za',                'Alex News',                   'JHB', 'en'),
  ('joburgeastexpress.co.za',       'Joburg East Express',         'JHB', 'en'),
  -- City of Tshwane
  ('rekord.co.za',                  'Rekord',                      'TSH', 'en'),
  -- City of Ekurhuleni
  ('germistoncitynews.co.za',       'Germiston City News',         'EKU', 'en'),
  ('kemptonexpress.co.za',          'Kempton Express',             'EKU', 'en'),
  ('bedfordviewedenvalenews.co.za', 'Bedfordview & Edenvale News', 'EKU', 'en'),
  ('benonicitytimes.co.za',         'Benoni City Times',           'EKU', 'en'),
  ('boksburgadvertiser.co.za',      'Boksburg Advertiser',         'EKU', 'en'),
  ('springsadvertiser.co.za',       'Springs Advertiser',          'EKU', 'en'),
  ('albertonrecord.co.za',          'Alberton Record',             'EKU', 'en'),
  ('brakpanherald.co.za',           'Brakpan Herald',              'EKU', 'en'),
  -- Sedibeng and the West Rand
  ('vaalweekblad.com',              'Vaal Weekblad',               'GT421', 'af'),
  ('heidelbergnigelheraut.co.za',   'Heidelberg/Nigel Heraut',     'GT423', 'af'),
  ('krugersdorpnews.co.za',         'Krugersdorp News',            'GT481', 'en'),
  ('carletonvilleherald.com',       'Carletonville Herald',        'GT484', 'en'),
  ('randfonteinherald.co.za',       'Randfontein Herald',          'GT485', 'en');

-- `enabled` is an editorial switch - for turning a title off because its
-- feed went bad or its coverage stopped being useful - and nothing else
-- touches it. An earlier cut set it false here for titles whose
-- municipality was not loaded yet, which had the opposite of the intended
-- effect: the title stayed off after sources:official ran, because nothing
-- ever switched it back on. The join in enabledTitles() handles that case
-- correctly and reversibly, so this does not need to.
