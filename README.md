# Venom

Ward-level campaign analytics. Raw tables → computed views → one materialised extract
that the dashboard reads from.

Ten views. Each is a window you can open, read and test independently. When they are
all correct they collapse into a single analytical layer.

## Layout

    db/migrations/   base table DDL (ward, station, asset_holding, call_log, control_panel)
    db/views/        the ten windows, numbered in dependency order
    db/extract/      the materialised extract the dashboard reads

## Status

| # | View                | State                              |
|---|---------------------|------------------------------------|
| 1 | v_ward_computed     | drafted                            |
| 2 | v_ward_reliability  | drafted                            |
| 3 | v_ward_shortage     | fragment only (`.wip`) — truncated |
| 4–10 | —                | not yet written                    |

Base table DDL is not written yet. The views reference columns that have no schema
behind them, so nothing runs end to end at this point.

## Dialect

Written as PostgreSQL. The aggregate `FILTER` clauses and `::numeric` casts are
Postgres-only and need rewriting for MySQL/MariaDB.
