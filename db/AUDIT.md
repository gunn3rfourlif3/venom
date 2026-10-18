# Audit of the ten windows

Read against the spec as written. Sections A and B have been **fixed** —
see "What changed" at the bottom for the diff in words. Sections C and D
are outstanding and are decisions, not defects.

Target dialect: **PostgreSQL**. See section D.

---

## A. Would not compile — FIXED

`v_ward_computed` exposed only: `ward_id, municipality, zone,
registered_voters, pool_size_2024, pool_split, pool_divisor,
our_pool_share, swing_index, headroom, activation_gap, pool_owner,
cost_per_body`.

Downstream views referenced columns it did not pass through:

| Reference            | Used in            | Resolution                                   |
|----------------------|--------------------|----------------------------------------------|
| `w.candidate_status` | Window 3, Window 8 | added as pass-through on Window 1            |
| `w.peak_turnout_pct` | Window 7           | added as pass-through on Window 1            |
| `w.t2024_turnout`    | Window 7           | added as pass-through on Window 1            |
| `w.m1_discounted`    | Window 3           | corrected to `r.m1_discounted`               |

Window 3 already joined `v_ward_reliability` as `r` but never used it. The
alias is now correct and the join earns its place.

## B. Returned the wrong answer silently — FIXED

1. **`stations_covered` was always 0.** Window 7's booth CTE and the extract
   both filtered `contested_flag = 'COVERED'`. `contested_flag` only returns
   `CONTESTED`, `OURS ALONE`, `THEIRS`, `NOBODY` — `COVERED` is a value of
   **`coverage_flag`**. Both predicates now read `coverage_flag`.

2. **The extract fanned out.** `LEFT JOIN v_asset_available f ON f.location =
   e.ward_id` produced one row per *(ward, asset_type)*, so any dashboard
   treating the extract as one-row-per-ward double-counted. Assets are now
   aggregated per ward into `assets_spend_first`, `assets_spend_second` and
   `assets_total`. The per-asset-type breakdown is still available by
   querying `v_asset_available` directly.

   With one row per ward, `idx_extract_ward` is now **UNIQUE**, which is what
   `REFRESH MATERIALIZED VIEW CONCURRENTLY` requires. Without it the nightly
   rebuild takes an exclusive lock on the table the dashboard is reading.

3. **`calibration_error` could never populate.** `eo_act_votes` was
   `NULL::integer` inside a view, and a view cannot be written to. Added
   `iec_result` (`db/migrations/001_iec_result.sql`) and joined it into
   Window 7. Empty until the IEC declaration is loaded, so `eo_act_votes`
   and `calibration_error` stay NULL until then — correctly, rather than
   structurally.

4. **`activation_gap` went negative** where 2024 was itself the peak. Now
   `GREATEST(0, …)`. The signed value is still derivable: both
   `peak_turnout_pct` and `t2024_turnout` are passed through.

5. **`cost_per_body` divided by the claimed `m1_weekday`**, not
   `m1_discounted`. Renamed to **`cost_per_body_claimed`** so the basis is
   visible at the call site — it understates cost in exactly the zones that
   over-claim. Not switched to the discounted basis, because that would mean
   either duplicating Window 2's discount formula inside Window 1 (two
   definitions that will drift) or inverting the dependency order of the two
   foundation views. Nothing downstream reads this column yet. **Decide where
   the planning-basis cost should live before anything consumes it.**

## C. Design gaps — outstanding

- **`control_panel` is never joined.** It is listed as an input to Window 8
  but no view reads it. Still hardcoded: `150` transport (W1, W5), `80`
  catering (W5), `0.10` leakage (W7), `0.5` reliability default (W2), and the
  `0.4 / 0.3 / 0.3` weights plus the `/1000` headroom scale (W8).

- **The priority score is swing-dominated.** `swing_index` is a raw vote
  count, `headroom/1000` is thousands of voters, `reliability_ratio` is 0–1.
  Weighting those 40/30/30 does not give 40/30/30 of the influence —
  reliability contributes at most 0.3 against a swing term in the tens.
  Normalise all three to a common scale before weighting.

- **Window 5 ignores the arbitrage hierarchy.** Its `pool` CTE sums across
  both `spend_order` values, so feasibility cannot tell SPEND_FIRST stock
  from SPEND_SECOND. The ordering Window 4 exists to establish is discarded
  at the point of use.

- **`call_log` is listed as a Window 2 input but never read.**

- **Base DDL is still missing** for `ward`, `station`, `asset_holding`,
  `liquidatable`, `deployment`, `float_ledger`, `call_log` and
  `control_panel`. Only `iec_result` has a migration. Nothing runs until
  these exist.

## D. Dialect — PostgreSQL

XAMPP ships MariaDB/MySQL, but XAMPP is a local Apache/PHP bundle and does
not oblige the project to use its database. Postgres runs alongside it and
PHP connects through PDO either way.

The decisive factor is the extract: **MySQL has no materialised views.** On
MySQL, `mv_campaign_extract` becomes a hand-maintained table plus an
event-scheduler rebuild — and that extract is the only thing the dashboard
reads. Every `FILTER` clause would also become `SUM(CASE WHEN … END)`.

**This flips only if the project deploys to MySQL-only shared hosting.** If
so, decide before the base DDL is written, not after.

---

## What changed

- `db/views/01_v_ward_computed.sql` — three pass-throughs added;
  `activation_gap` floored at zero; `cost_per_body` → `cost_per_body_claimed`
- `db/views/03_v_ward_shortage.sql` — `w.m1_discounted` → `r.m1_discounted`
- `db/views/07_v_ward_eo.sql` — `contested_flag` → `coverage_flag`;
  `eo_act_votes` now sourced from `iec_result`
- `db/extract/mv_campaign_extract.sql` — assets aggregated per ward;
  `coverage_flag` fix applied here too; `idx_extract_ward` now UNIQUE
- `db/migrations/001_iec_result.sql` — new
