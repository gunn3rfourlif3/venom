# Audit of the ten windows

Read against the spec as written. The views in `db/views/` are committed
verbatim so the repo matches the design document. Nothing here has been
"fixed" silently — this is the list to work from.

## A. Will not compile

`v_ward_computed` exposes only: `ward_id, municipality, zone,
registered_voters, pool_size_2024, pool_split, pool_divisor,
our_pool_share, swing_index, headroom, activation_gap, pool_owner,
cost_per_body`.

Downstream views reference columns it does not pass through:

| Reference            | Used in            | Status                              |
|----------------------|--------------------|-------------------------------------|
| `w.candidate_status` | Window 3, Window 8 | not selected by Window 1            |
| `w.peak_turnout_pct` | Window 7           | not selected by Window 1            |
| `w.t2024_turnout`    | Window 7           | not selected by Window 1            |
| `w.m1_discounted`    | Window 3           | lives in `v_ward_reliability` (`r`) |

Window 3 already joins `v_ward_reliability` as `r` but never uses it —
`w.m1_discounted` should read `r.m1_discounted`.

**Fix:** add `candidate_status`, `peak_turnout_pct`, `t2024_turnout` as
pass-throughs on Window 1, and correct the one alias in Window 3. That
single change clears every item in this section.

## B. Returns the wrong answer silently

1. **`stations_covered` is always 0.** Window 7's booth CTE and the extract
   both filter `WHERE contested_flag = 'COVERED'`. `contested_flag` only ever
   returns `CONTESTED`, `OURS ALONE`, `THEIRS`, `NOBODY`. `COVERED` is a
   value of **`coverage_flag`**. The predicate never matches, so
   `stations_covered` and `presence` evidence read zero everywhere.

2. **The extract fans out.** `LEFT JOIN v_asset_available f ON f.location =
   e.ward_id` — `v_asset_available` is one row per *(location, asset_type)*.
   The extract becomes several rows per ward, so a dashboard treating it as
   one-row-per-ward double-counts. It also blocks a unique index on
   `ward_id`, which blocks `REFRESH MATERIALIZED VIEW CONCURRENTLY` — the
   nightly refresh will take an exclusive lock instead.

3. **`calibration_error` is permanently NULL.** `eo_act_votes` is
   `NULL::integer` inside a view, and a view cannot be written to. The IEC
   booth count needs its own table joined into Window 7.

4. **`activation_gap` can go negative** when 2024 *was* the peak. Wrap in
   `GREATEST(0, …)` unless negatives are meant to be read as "already past
   the ceiling".

5. **`cost_per_body` divides by `m1_weekday`**, the claimed figure — not
   `m1_discounted`, the number Window 2 says you actually plan with. Cost
   per body is understated in exactly the zones that over-claim.

## C. Design gaps

- **`control_panel` is never joined.** It is listed as an input to Window 8
  but no view reads it. Hardcoded: `150` transport (W1, W5), `80` catering
  (W5), `0.10` leakage (W7), `0.5` reliability default (W2), and the
  `0.4 / 0.3 / 0.3` weights plus the `/1000` headroom scale (W8).

- **The priority score is swing-dominated.** `swing_index` is a raw vote
  count, `headroom/1000` is thousands of voters, `reliability_ratio` is
  0–1. Weighting those 40/30/30 does not give 40/30/30 of the influence —
  reliability contributes at most 0.3 against a swing term in the tens.
  Normalise the three to a common scale first.

- **Window 5 ignores the arbitrage hierarchy.** The `pool` CTE sums across
  both `spend_order` values, so feasibility cannot tell SPEND_FIRST stock
  from SPEND_SECOND. The ordering Window 4 establishes is discarded.

- **`call_log` is listed as a Window 2 input but never read.**

- **No base DDL.** `ward`, `station`, `asset_holding`, `liquidatable`,
  `deployment`, `float_ledger`, `call_log`, `control_panel` have no schema
  in the repo. `db/migrations/` is empty.

## D. Dialect

The project folder is under XAMPP, which ships MariaDB/MySQL. These views
are PostgreSQL and will not run there as written:

- `COUNT(*) FILTER (WHERE …)` — no MySQL equivalent; rewrite as
  `SUM(CASE WHEN … THEN 1 ELSE 0 END)`.
- `::numeric` casts — rewrite as `CAST(x AS DECIMAL(…))`.
- `CREATE MATERIALIZED VIEW` — **does not exist in MySQL/MariaDB.** The
  extract has to become a real table plus a scheduled rebuild.
- `NULL::integer`, `NULL::numeric` — rewrite as plain `NULL` with an
  explicit cast where the column type matters.

If the dashboard is running on XAMPP's MySQL, this is the first decision to
make, because it changes every file in `db/views/`.
