# Venom

Ward-level campaign analytics. Raw tables → computed views → one materialised
extract that the dashboard reads from.

Ten views. Each is a window you can open, read and test independently. When
they are all correct they collapse into a single analytical layer.

## Layout

    db/migrations/   base table DDL — not yet written
    db/views/        the ten windows, numbered in dependency order
    db/extract/      the materialised extract the dashboard reads
    db/AUDIT.md      defects found against the spec

## The ten windows

| #  | View                      | Reads                                              |
|----|---------------------------|----------------------------------------------------|
| 1  | `v_ward_computed`         | `ward`                                              |
| 2  | `v_ward_reliability`      | `ward`, `call_log`                                  |
| 3  | `v_ward_shortage`         | 1, 2, `station`, `asset_holding`                    |
| 4  | `v_asset_available`       | `asset_holding`, `liquidatable`                     |
| 5  | `v_deployment_feasibility`| `deployment`, 2, 4                                  |
| 6  | `v_booth_status`          | `station`                                           |
| 7  | `v_ward_eo`               | 1, 3, 6                                             |
| 8  | `v_priority_rank`         | 1, 2, 3, `control_panel`                            |
| 9  | `v_campaign_eo`           | 7, 4                                                |
| 10 | `v_float_balance`         | `float_ledger`                                      |
|    | `mv_campaign_extract`     | 7, 8, 2, 6, 4                                       |

## Build order

Start with `v_ward_computed` and `v_ward_reliability`. Those two are the
foundation; everything downstream depends on their numbers being right. If
those two return correct results on three test wards, the rest is mechanical.

Views are inspectable — each can be queried in isolation, tested with a single
ward, and debugged without touching the rest. The materialised view is fast but
opaque. Build the views, verify each against a known ward, then collapse. The
collapse takes minutes. The verification is the work.

## Status

Committed as written in the spec. **Nothing runs yet:**

- no base table DDL, so there is nothing underneath the views
- four downstream column references do not exist on `v_ward_computed`
- target dialect unresolved (written for PostgreSQL; XAMPP ships MySQL)

See `db/AUDIT.md` for the full list.

## Scope boundary

No donor-to-amount reconciliation. No receipt structure. No named shrinkage
line. `v_float_balance` reports issued, accounted, and the gap.
