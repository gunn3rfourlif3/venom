-- Trending topics — what is moving, not what is loudest.
--
-- There are no headlines in this database. The news and press adapters read
-- text, score it, and keep counts; the text is dropped and `stores_text` is
-- false on every source for that reason. So a "news ticker" here cannot show
-- headlines, and pretending otherwise would mean storing article text the
-- system was deliberately built not to hold.
--
-- What it can show is movement: which issue, in which municipality, is being
-- written about more than it was. That is the question a ticker is actually
-- useful for — a standing count tells you Johannesburg has a lot of
-- electricity coverage, which is true every week and therefore not news.
--
-- TWO GUARDS, both learned the hard way elsewhere in this project:
--
--   Synthetic rows are excluded outright. A ticker scrolling invented
--   trends across the bottom of every screen is the most persuasive way
--   possible to present fabricated data as fact.
--
--   A minimum volume, because a rise from 1 to 3 is 200% and means nothing.
--   Percentage change on small numbers is how a ticker ends up shouting
--   about noise.

CREATE OR REPLACE VIEW v_trending_topics AS
WITH windowed AS (
  SELECT s.demarcation_code,
         s.category,
         sum(s.mentions) FILTER (
           WHERE s.observed_on > current_date - 14)                    AS recent,
         sum(s.mentions) FILTER (
           WHERE s.observed_on <= current_date - 14
             AND s.observed_on >  current_date - 28)                   AS prior,
         avg(s.net_sentiment) FILTER (
           WHERE s.observed_on > current_date - 14)                    AS tone,
         max(s.observed_on)                                            AS last_seen
    FROM issue_signal s
   WHERE s.observed_on > current_date - 28
     AND s.demarcation_code IS NOT NULL
     -- Never let invented data scroll across the screen as if it were news.
     AND s.source <> 'SYNTHETIC'
   GROUP BY s.demarcation_code, s.category
)
SELECT m.name                                   AS municipality,
       m.province_name                          AS province,
       w.category::text                         AS category,
       w.recent::int                            AS recent,
       COALESCE(w.prior, 0)::int                AS prior,
       (w.recent - COALESCE(w.prior, 0))::int   AS change,
       CASE
         WHEN COALESCE(w.prior, 0) = 0 THEN NULL
         ELSE round(100.0 * (w.recent - w.prior) / w.prior, 0)
       END                                      AS pct_change,
       CASE
         WHEN COALESCE(w.prior, 0) = 0           THEN 'NEW'
         WHEN w.recent >= w.prior * 1.25         THEN 'UP'
         WHEN w.recent <= w.prior * 0.75         THEN 'DOWN'
         ELSE 'STEADY'
       END                                      AS direction,
       round(w.tone, 2)                         AS tone,
       w.last_seen
  FROM windowed w
  JOIN municipality m USING (demarcation_code)
 -- Below this, a "trend" is one or two articles and a coin toss.
 WHERE w.recent >= 3
 ORDER BY (w.recent - COALESCE(w.prior, 0)) DESC, w.recent DESC;

COMMENT ON VIEW v_trending_topics IS
  'Issue x municipality movement over the last 14 days against the 14 before. '
  'Counts only — this system stores no article text. Synthetic rows excluded '
  'and a minimum volume applied, so the ticker cannot shout about noise or '
  'about data that was invented.';
