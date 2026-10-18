# Expected values for the three-ward fixture

Computed by hand, then confirmed against PostgreSQL 16. If a change to the
views moves any of these, the change is wrong until proven otherwise.

Run order: `db/migrations/*.sql`, `db/views/*.sql`, `db/extract/*.sql`,
then `db/test/001_seed_three_wards.sql`.

## Window 1 — v_ward_computed

Contestability is decided on the rival's **loss of share** between the two
elections, not on a raw vote difference across them.

| ward | rival share 2021 | rival share 2024 | decline | contestable | headroom | gap_lge | gap_all |
|---|---|---|---|---|---|---|---|
| JHB-001 | 0.5769 | 0.5556 | 0.0214 | f | 9600 | 6.00 | 14.00 |
| JHB-002 | 0.5556 | 0.5000 | 0.0556 | t | 7800 | 7.00 | 14.00 |
| JHB-003 | 0.5818 | 0.4800 | 0.1018 | t | 11250 | 5.00 | 15.00 |

Worked example, JHB-001: the rival took 6000 votes from the 10400 cast in
2021 (20000 × 52%), a share of 0.5769; and 5000 from the 9000 cast in 2024
(20000 × 45%), a share of 0.5556. It gave up 2.14 points, under the 5-point
threshold, so the ward is not contestable.

Headroom and activation gap are measured against `t2021_turnout`, the last
**local** turnout, because the contest is local: 20000 × (1 − 0.52) = 9600,
and 58.00 − 52.00 = 6.00 points of activation room on the LGE peak.

The legacy `swing_index` is still exposed and still computed the old way
(−3000, 0 and +1000 for the three wards). Nothing decides anything on it.
JHB-002 is the demonstration: its raw swing is exactly zero while the rival
shed 5.6 points of share.

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

All three leakage bases are computed; `control_panel.leakage_basis` selects
which one `eo_est_votes` follows. Default is OWN_VOTE.

| ward | A | abstention | leak ALL | leak POOL_SHARE | leak OWN_VOTE | L | EO est |
|---|---|---|---|---|---|---|---|
| JHB-001 | 4350 | 2088 | 900 | 338 | **300** | 2388 | 1962 |
| JHB-002 | 4714 | 2451 | 600 | 343 | **400** | 2851 | 1863 |
| JHB-003 | 9000 | 4050 | 1250 | 750 | **900** | 4950 | 4050 |

Worked example, JHB-001: A = 20000 × 0.58 × 0.375 = 4350. Abstention =
4350 × (1 − 0.52) = 2088, measured from the last **local** turnout.
Leakage on OWN_VOTE = 3000 × 0.10 = 300. EO = 4350 − 2388 = 1962.

The same ward on ALL would be charged 20000 × 0.45 × 0.10 = 900 — three
times as much, and most of it the rival's voters. Across the 523-ward
dataset ALL drives 430 wards to a negative EO; the other two bases drive
none. See `db/AUDIT.md`.

## Window 8 — v_priority_rank

Ranked by box first, score within the box.

| priority_rank | score_rank | ward | box | score | gap_flag |
|---|---|---|---|---|---|
| 1 | 3 | JHB-002 | Recruit | 0.2000 | URGENT |
| 2 | 1 | JHB-003 | Contest | 1.0000 | |
| 3 | 2 | JHB-001 | Hold | 0.3000 | |

JHB-002 scores lowest of the three and still ranks first, because it is the
emergency: contestable, with no candidate. `score_rank` keeps the old
score-only ordering visible beside it. Under the previous scheme the URGENT
ward ranked last — on the 523-ward dataset, rank 1 was an Abandon ward and
the only Contest ward sat at 81.

## Window 9 — v_campaign_eo

On OWN_VOTE: A 18064 · L 10189 · EO est 7875 · wards 3 · declared 0 ·
no candidate 1 · people gap 8 · liquidatable T-shirts 300 · surplus 550.

Leakage totals across the three bases: ALL 2750 · POOL_SHARE 1431 ·
OWN_VOTE 1600.

`calibration_error` is null because nothing is declared. Correct.

## Window 10 — v_float_balance

Zone 1, week ending 2026-10-11: issued 10000, accounted 8500, shrinkage 1500
(15.00%), recorded by Test Treasurer.

## The extract

3 wards in, 3 rows out, 3 distinct ward ids. `REFRESH MATERIALIZED VIEW
CONCURRENTLY` succeeds, which is the property the unique index exists to
guarantee.
