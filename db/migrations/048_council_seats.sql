-- The socket the seat engine plugs into.
--
-- `src/seats/allocate.ts` reproduces both published 2021 results exactly, and
-- it cannot run on this database at all, because the one input it cannot
-- derive is missing: how many seats each council has. The quota is
--
--     total valid votes / (total council seats - independent seats + 1)
--
-- so without `total_seats` there is no quota, and without a quota there are
-- no seats. The engine has been a validated library with nothing to read.
--
-- WHY total_seats IS NULLABLE AND STAYS NULL UNTIL SOMEONE CONFIRMS IT.
--
-- It is tempting to derive it. Section 22(2) of the Structures Act sets ward
-- councillors at 50% of the total, rounded up when the total is odd. So for a
-- council with w wards, the total is either 2w or 2w-1 - and which of the two
-- it is cannot be recovered from the ward count.
--
-- That ±1 is not a rounding detail. It sits in the quota's denominator, and
-- on the Sol Plaatje 2021 fixture a quota moved by 25 votes was enough to
-- hand the ANC a seat it did not win and take one off the FF+. A seat
-- projection built on a guessed denominator would be wrong in exactly the way
-- that is hardest to notice: plausible, specific, and confidently displayed.
--
-- So `ward_seats` is populated now, because it is a fact already in the
-- register. `total_seats` is left NULL, the projection refuses to run for any
-- municipality where it is NULL, and the refusal names the municipality. An
-- empty hemicycle that says why is worth more than a full one that is wrong.
--
-- WHERE THE REAL NUMBER COMES FROM. The MEC for local government in each
-- province determines the number of councillors per council by notice in the
-- Provincial Gazette, and the IEC publishes seat totals with the results.
-- Either is authoritative. `source` records which was used.

CREATE TABLE IF NOT EXISTS council_seats (
  demarcation_code text PRIMARY KEY
    REFERENCES municipality (demarcation_code),

  -- Total councillors on the council: ward plus PR. The quota denominator.
  total_seats      integer
                   CHECK (total_seats IS NULL OR total_seats > 0),

  -- Ward seats. Derived from the register, which is the IEC's own
  -- delimitation, so this one is a fact rather than an assumption.
  ward_seats       integer NOT NULL
                   CHECK (ward_seats >= 0),

  -- Seats filled from the PR list. Held rather than computed so that a
  -- confirmed figure can disagree with total - ward and be seen to disagree.
  pr_seats         integer
                   CHECK (pr_seats IS NULL OR pr_seats >= 0),

  source           text NOT NULL DEFAULT 'DERIVED_WARD_COUNT',
  source_url       text,
  confirmed_on     date,
  notes            text,
  updated_at       timestamptz NOT NULL DEFAULT now(),

  -- A confirmed total must agree with its parts. Unconfirmed rows are exempt
  -- because their total is NULL and there is nothing to disagree with.
  CONSTRAINT seats_add_up CHECK (
    total_seats IS NULL OR pr_seats IS NULL
    OR total_seats = ward_seats + pr_seats),

  -- Anything claiming to be confirmed must carry a total and a date. The
  -- point of the column is to distinguish knowing from assuming; a
  -- "confirmed" row with no number defeats it.
  CONSTRAINT confirmed_means_known CHECK (
    source = 'DERIVED_WARD_COUNT'
    OR (total_seats IS NOT NULL AND confirmed_on IS NOT NULL))
);

COMMENT ON TABLE council_seats IS
  'Seats per council. ward_seats is a fact from the register; total_seats is '
  'NULL until confirmed from a Provincial Gazette notice or the IEC, because '
  'it cannot be derived from the ward count - a council with w wards has '
  'either 2w or 2w-1 seats and the difference moves the quota.';

COMMENT ON COLUMN council_seats.total_seats IS
  'Total councillors, ward + PR. The quota denominator. NULL means not yet '
  'confirmed, and the seat projection refuses to run rather than guess.';


/* Ward counts from the register. Category C (district) councils hold no wards
   and are excluded: their seats are filled 40% from the local councils in the
   district and 60% by direct PR election, which is a different calculation
   and not one this table models. */
INSERT INTO council_seats (demarcation_code, ward_seats, source, notes)
SELECT m.demarcation_code,
       count(w.ward_id)::int,
       'DERIVED_WARD_COUNT',
       'ward_seats from the 2026 register; total_seats not yet confirmed'
  FROM municipality m
  JOIN ward w ON w.demarcation_code = m.demarcation_code
 WHERE m.category IN ('A', 'B')
 GROUP BY m.demarcation_code
ON CONFLICT (demarcation_code) DO UPDATE
   SET ward_seats = EXCLUDED.ward_seats,
       updated_at = now()
 WHERE council_seats.source = 'DERIVED_WARD_COUNT';


/* What the seat engine is still waiting for, per council, in one place.
 *
 * This is the screen that answers "what do I still need before this works",
 * which is a different question from "is it broken". Nothing here is an
 * error: it is a list of inputs that have not arrived. */
CREATE OR REPLACE VIEW v_seat_readiness AS
SELECT
  cs.demarcation_code,
  m.name                                   AS municipality,
  m.province_name                          AS province,
  m.category                               AS municipality_category,
  cs.ward_seats,
  cs.total_seats,
  cs.source                                AS seats_source,
  cs.confirmed_on,
  -- The two possible totals, so whoever confirms it knows what to look for.
  cs.ward_seats * 2                        AS total_if_even,
  cs.ward_seats * 2 - 1                    AS total_if_odd,
  (SELECT count(*)::int FROM candidate c
    WHERE c.demarcation_code = cs.demarcation_code
      AND c.list_order IS NOT NULL)        AS pr_list_loaded,
  (SELECT count(*)::int FROM candidate c
    WHERE c.demarcation_code = cs.demarcation_code
      AND c.ward_id IS NOT NULL)           AS ward_candidates_loaded,
  (SELECT count(*)::int FROM result_slip rs
     JOIN station st ON st.station_id = rs.station_id
     JOIN ward w ON w.ward_id = st.ward_id
    WHERE w.demarcation_code = cs.demarcation_code
      AND rs.rejected IS NULL)             AS slips_captured,
  CASE
    WHEN cs.total_seats IS NULL THEN 'needs council seat total'
    WHEN NOT EXISTS (SELECT 1 FROM candidate c
                      WHERE c.demarcation_code = cs.demarcation_code)
      THEN 'needs certified candidate list'
    WHEN NOT EXISTS (SELECT 1 FROM result_slip rs
                       JOIN station st ON st.station_id = rs.station_id
                       JOIN ward w ON w.ward_id = st.ward_id
                      WHERE w.demarcation_code = cs.demarcation_code
                        AND rs.rejected IS NULL)
      THEN 'ready - waiting for results'
    ELSE 'projectable'
  END                                      AS status
FROM council_seats cs
JOIN municipality m ON m.demarcation_code = cs.demarcation_code;

COMMENT ON VIEW v_seat_readiness IS
  'Per council: what the seat engine still needs before it can project. '
  '"ready - waiting for results" means every input is in place and only '
  'polling day is outstanding.';
