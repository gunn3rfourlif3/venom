-- Register completeness, watched rather than discovered.
--
-- On 22 October the register was short 2,366 voting stations and every one of
-- them was in Gauteng: 354 wards with no station at all, in the only province
-- the campaign is actually fighting. Nothing reported it. It surfaced only
-- because synthetic development rows were deleted and the hole they had been
-- covering became visible. (OPEN-QUESTIONS Q18.)
--
-- The failure was not the missing data. It was that an incomplete register
-- looked exactly like a complete one. Every screen read from `ward`, every
-- ward was present, and the absence lived one join further down where nothing
-- looked.
--
-- So this view exists to make that specific absence loud, permanently:
--
--   * A ward with no voting station is counted, per province, and is the
--     headline number. It is the shape the Gauteng failure took.
--   * Stations per ward is carried alongside, because the next version of
--     this failure is a ward that imported ONE station when it has nine -
--     present, non-zero, and still wrong. A province sitting far below the
--     national rate is the signal.
--   * Provenance is counted, so a reappearance of non-IEC rows is visible
--     rather than quietly folded into the totals.
--
-- It deliberately does NOT compare against a hardcoded expected station count
-- per province. We hold no authoritative per-province figure, and inventing
-- one would mean the map reporting a confident number nobody can check -
-- which is the habit this project keeps having to correct.

CREATE OR REPLACE VIEW v_register_completeness AS
WITH per_ward AS (
  SELECT w.ward_id,
         m.province_name AS province,
         count(s.station_id)::int AS stations,
         count(*) FILTER (WHERE s.source = 'IEC_GIS')::int AS iec_stations
    FROM ward w
    JOIN municipality m ON m.demarcation_code = w.demarcation_code
    LEFT JOIN station s ON s.ward_id = w.ward_id
   GROUP BY w.ward_id, m.province_name
)
SELECT
  province,
  count(*)::int                                        AS wards,
  count(*) FILTER (WHERE stations = 0)::int            AS wards_without_stations,
  sum(stations)::int                                   AS stations,
  sum(stations - iec_stations)::int                    AS stations_not_from_iec,
  round(avg(stations)::numeric, 2)                     AS stations_per_ward,

  /* One word for the province, so the panel never has to decide what a
     number means. A ward with no station is a failure whatever else is
     true, so it outranks everything below it. */
  CASE
    WHEN count(*) FILTER (WHERE stations = 0) > 0 THEN 'incomplete'
    WHEN sum(stations - iec_stations) > 0          THEN 'unverified'
    ELSE 'complete'
  END AS status

FROM per_ward
GROUP BY province
ORDER BY
  (count(*) FILTER (WHERE stations = 0)) DESC,
  province;

COMMENT ON VIEW v_register_completeness IS
  'Per-province register completeness for the completeness panel. Exists '
  'because on 22 Oct the register was short 2,366 stations across 354 '
  'Gauteng wards and nothing reported it - an incomplete register looked '
  'identical to a complete one. wards_without_stations is the shape that '
  'failure took; stations_per_ward catches the subtler version where a ward '
  'imports one station instead of nine.';
