# Audit of the ten windows

Everything in sections A, B and C is **fixed and verified**. The whole stack
has been run against PostgreSQL 16: all 22 files create cleanly, and every
figure in `db/test/EXPECTED.md` was computed by hand and then confirmed
against the database.

Target dialect: **PostgreSQL**, confirmed — the project deploys to a VPS.
Scope: **Gauteng, 2026 municipal elections.**

---

## A. Would not compile — FIXED

`v_ward_computed` did not pass through columns that Windows 3, 7 and 8 read
off its alias, and Window 3 read `m1_discounted` off the wrong alias.

| Reference | Used in | Resolution |
|---|---|---|
| `w.candidate_status` | Windows 3, 8 | pass-through added |
| `w.peak_turnout_pct` | Window 7 | now resolved from both peak bases |
| `w.t2024_turnout` | Window 7 | pass-through added |
| `w.m1_discounted` | Window 3 | corrected to `r.m1_discounted` |

## B. Returned the wrong answer silently — FIXED

1. `stations_covered` filtered `contested_flag = 'COVERED'`, a value that flag
   never takes. Both occurrences now read `coverage_flag`.
2. The extract joined `v_asset_available` row-per-asset-type and fanned out.
   Assets are aggregated per ward; `idx_extract_ward` is UNIQUE and
   `REFRESH CONCURRENTLY` is verified working.
3. `eo_act_votes` was `NULL::integer` inside a view. Now sourced from
   `iec_result`.
4. `activation_gap` went negative past the peak. Floored at zero.
5. `cost_per_body` divided by claimed capacity under a name that implied a
   planning figure. Moved to Window 2, which holds both inputs, and split
   into `cost_per_body_claimed` and `cost_per_body_planned`.

## C. Design gaps — FIXED

- **`control_panel` is now joined.** Nothing is hardcoded in a view. It
  carries the transport and catering rates, the leakage factor, the
  reliability default, the contestability threshold, the three priority
  weights, and the peak basis. Weights are constrained to sum to 1.
- **The priority score is normalised.** Each of the three terms is converted
  to its percentile rank across the ward set before weighting, so a weight of
  0.4 now means 0.4 of the influence. Percentile rather than min-max: one
  outlier ward would otherwise compress everything else to the floor.
- **`v_deployment_feasibility` respects the spend order.** The pool is split
  by `spend_order` and the view reports `draw_from_first` and
  `draw_from_second`, so liquidatables are exhausted before own stock. It
  also now names the `binding_constraint`, so a short plan can be fixed
  rather than only refused.
- **The `CENTRAL` sentinel is gone.** `asset_holding` hangs off a `location`
  table with a `kind`, which generalises to the several depots a provincial
  campaign will run and removes the `WHERE ward_id <> 'CENTRAL'` filter.
- **`call_log` exists but is still unread.** Telephone canvassing is deferred
  by decision. The table deliberately holds counts per ward per day, not
  records per person.
- **The m-numbering is contiguous.** The original ran m1, m2, m3, m5, m6 with
  no m4. Now m1–m5. The m-prefix shorthand was kept deliberately: it is the
  campaign's own vocabulary.

---

## Open, by decision rather than defect

**The contestability threshold is a share, not a vote count.**
`control_panel.swing_threshold_share` defaults to 0.05. This matters for
Gauteng specifically: MK's 2024 displacement was concentrated in KwaZulu-Natal,
so Gauteng swing figures are an order of magnitude smaller and a raw-count
threshold tuned elsewhere would classify nearly every ward identically. The
default has not been calibrated against real Gauteng data — do that as soon as
the IEC baseline loads.

**The priority rank penalises wards you have never worked.** Verified on the
fixture: JHB-002 is flagged `URGENT` — contestable, no candidate — and ranks
last, because a ward with no deployment history scores percentile 0 on
reliability. The emergency list and the priority list therefore point in
opposite directions. Decide whether a null `reliability_ratio` should sit at
percentile 0 or at the median; the current behaviour biases the ranking
against new ground, which is the opposite of what a displacement strategy
wants.

**`peak_turnout_pct` carries both bases.** `peak_turnout_lge_pct` and
`peak_turnout_all_pct` are both stored and both exposed;
`control_panel.peak_basis` selects which drives the EO arithmetic. Default is
LGE, because local turnout runs well below national and an `ALL` basis sets a
ceiling a municipal election will not reach — inflating every
`a_potential_votes` figure. Both are visible so the two can be compared.

**The forecast is unhedged.** The model projects 2024 national results onto
2026 ward contests. National-to-local transfer is historically weak and
turnout drops sharply between the two, so `swing_index` likely runs generous.
`calibration_error` measures this, but only after the declaration.

---

## Verification

```
psql -d venom -f db/migrations/*.sql   # in order
psql -d venom -f db/views/*.sql        # in order
psql -d venom -f db/extract/mv_campaign_extract.sql
psql -d venom -f db/test/001_seed_three_wards.sql
```

Then check every figure against `db/test/EXPECTED.md`. All of them were
confirmed against PostgreSQL 16 on 2026-10-18.
