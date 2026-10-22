-- Hashtag quota, made visible.
--
-- Instagram allows 30 unique hashtags per account per ROLLING SEVEN DAYS.
-- The clock starts at a tag's first query and does not reset when the same
-- tag is queried again, so the thirty are spent on distinct tags, not on
-- requests. Resolving a tag's id costs one of them too.
--
-- The adapter already refuses to start a run that would exceed the cap. What
-- has been missing is anywhere for a person to SEE the budget before they
-- spend it: someone adding a tenth hashtag has no way to know whether that
-- is free or whether it costs the last slot until Thursday. A quota that
-- only exists inside a client is a quota that gets discovered by error.
--
-- X is not in here. It bills per post returned rather than per tag, so its
-- constraint is money and is governed by the budget the client is given.

CREATE OR REPLACE VIEW v_hashtag_window AS
SELECT h.tag,
       h.demarcation_code,
       m.name AS municipality,
       h.category::text        AS category,
       h.enabled,
       h.hashtag_id IS NOT NULL AS resolved,
       h.last_queried_at,
       h.last_media_count,
       h.note,
       /* A tag queried inside the window is holding one of the thirty. One
          never queried is free to add; one that has aged out is free again. */
       (h.last_queried_at IS NOT NULL
        AND h.last_queried_at > now() - interval '7 days') AS in_window,
       CASE WHEN h.last_queried_at IS NOT NULL
             AND h.last_queried_at > now() - interval '7 days'
            THEN h.last_queried_at + interval '7 days'
       END AS slot_frees_at
  FROM instagram_hashtag h
  LEFT JOIN municipality m ON m.demarcation_code = h.demarcation_code;

COMMENT ON VIEW v_hashtag_window IS
  'Curated hashtags with their position in the rolling 7-day Instagram quota. '
  'in_window means this tag is currently holding one of the thirty slots.';

CREATE OR REPLACE VIEW v_hashtag_quota AS
SELECT 30                                                   AS cap,
       count(*) FILTER (WHERE in_window)                    AS used,
       30 - count(*) FILTER (WHERE in_window)               AS remaining,
       count(*)                                             AS tags_total,
       count(*) FILTER (WHERE enabled)                      AS tags_enabled,
       /* A tag with no municipality cannot be attributed to a ward and is
          not ingested — recorded rather than guessed (migration 022). Worth
          surfacing, because such a tag looks configured and does nothing. */
       count(*) FILTER (WHERE enabled AND demarcation_code IS NULL)
                                                            AS enabled_without_place,
       min(slot_frees_at) FILTER (WHERE in_window)          AS next_slot_frees_at
  FROM v_hashtag_window;

COMMENT ON VIEW v_hashtag_quota IS
  'The 30-per-7-days budget as a single row. next_slot_frees_at is when the '
  'oldest in-window tag ages out and a slot returns.';
