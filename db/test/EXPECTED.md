# Expected values for the three-ward fixture

Computed by hand, then confirmed against PostgreSQL 16. If a change to the
views moves any of these, the change is wrong until proven otherwise.

Run order: `db/migrations/*.sql`, `db/views/*.sql`, `db/extract/*.sql`,
then `db/test/001_seed_three_wards.sql`.

## Window 1 — v_ward_computed

| ward | pool | our_share | swing_index | swing_share | contestable | headroom | gap_lge | gap_all | owner |
|---|---|---|---|---|---|---|---|---|---|
| JHB-001 | 8000 | 0.3750 | −3000 | −0.3750 | f | 11000 | 13 | 21 | THEIRS |
| JHB-002 | 7000 | 0.5714 | 2000 | 0.2857 | t | 9000 | 15 | 22 | OURS |
| JHB-003 | 15000 | 0.6000 | 5000 | 0.3333 | t | 12500 | 10 | 20 | OURS |

`activation_gap` follows `control_panel.peak_basis`, which defaults to LGE.

## Window 2 — v_ward_reliability

| ward | m1 | m3 | ratio | m1_discounted | cost_claimed | cost_planned |
|---|---|---|---|---|---|---|
| JHB-001 | 30 | 12 | 0.4000 | 12 | 100.00 | 250.00 |
| JHB-002 | 20 | — | null | 10 | 112.50 | 225.00 |
| JHB-003 | 40 | 36 | 0.9000 | 36 | 112.50 | 125.00 |

JHB-002 has never deployed, so `m1_discounted` falls back to
`control_panel.reliability_default` (0.5): 20 × 0.5 = 10.

The claimed and planned costs diverge most where the zone over-claims most:
JHB-001 reports 30 and delivers 12, so a body costs 250, not 100.

## Window 3 — v_ward_shortage

| ward | candidate | people | presence | stations | covered | pledges |
|---|---|---|---|---|---|---|
| JHB-001 | 0 | 0 | 0 | 2 | 1 | 40 |
| JHB-002 | 1 | 8 | 1 | 1 | 0 | 0 |
| JHB-003 | 0 | 0 | 0 | 2 | 2 | 75 |

## Window 5 — v_deployment_feasibility

Deployment 1 (JHB-003, 400 shirts): draws 300 from SPEND_FIRST and 100 from
SPEND_SECOND, feasibility OK. The arbitrage order survives to the point of
use: liquidatables are exhausted before own stock is touched.

Deployment 2 (JHB-002, 15 kitted): SHORT, binding constraint PEOPLE — ward
capacity after discount is 10.

## Window 6 — v_booth_status

S5 returns `LOITERING`: two people present, zero pledges. That flag is the
failure mode the view exists to surface.

## Window 7 — v_ward_eo (LGE peak basis)

| ward | A | abstention | leakage | L | EO est |
|---|---|---|---|---|---|
| JHB-001 | 4350 | 2393 | 900 | 3293 | 1058 |
| JHB-002 | 4714 | 2829 | 600 | 3429 | 1286 |
| JHB-003 | 9000 | 4500 | 1250 | 5750 | 3250 |

Worked example, JHB-001: A = 20000 × 0.58 × 0.375 = 4350. Abstention =
4350 × (1 − 0.45) = 2392.5. Leakage = 20000 × 0.45 × 0.10 = 900.
EO = 4350 − 3292.5 = 1057.5, rounded to 1058.

## Window 8 — v_priority_rank

| rank | ward | box | gap_flag |
|---|---|---|---|
| 1 | JHB-003 | Contest | |
| 2 | JHB-001 | Hold | |
| 3 | JHB-002 | Recruit | URGENT |

**Known tension:** JHB-002 is the URGENT ward and ranks last. It is
contestable with no candidate, but has the lowest headroom and no deployment
history, so its reliability percentile is 0. See `db/AUDIT.md`.

## Window 9 — v_campaign_eo

A 18064 · L 12472 · EO est 5594 · wards 3 · declared 0 · no candidate 1 ·
people gap 8 · no presence 1 · liquidatable T-shirts 300 · surplus 550.

`calibration_error` is null because nothing is declared. Correct.

## Window 10 — v_float_balance

Zone 1, week ending 2026-10-11: issued 10000, accounted 8500, shrinkage 1500
(15.00%), recorded by Test Treasurer.

## The extract

3 wards in, 3 rows out, 3 distinct ward ids. `REFRESH MATERIALIZED VIEW
CONCURRENTLY` succeeds, which is the property the unique index exists to
guarantee.
