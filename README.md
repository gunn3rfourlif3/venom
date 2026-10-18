# Venom

Ward-level campaign analytics for **Gauteng, 2026 municipal elections**.
Raw tables → computed views → one materialised extract the dashboard reads.

Ten views. Each is a window you can open, read and test independently. When
they are all correct they collapse into a single analytical layer.

## Layout

    db/migrations/   base table DDL, in order
    db/views/        the ten windows, numbered in dependency order
    db/extract/      the materialised extract the dashboard reads
    db/test/         three-ward fixture and its hand-computed expected values
    db/AUDIT.md      what was found, what was fixed, what is open by decision

## The ten windows

| #  | View                      | Reads                                        |
|----|---------------------------|----------------------------------------------|
| 1  | `v_ward_computed`         | `ward`, `control_panel`                       |
| 2  | `v_ward_reliability`      | `ward`, `control_panel`                       |
| 3  | `v_ward_shortage`         | 1, 2, `station`, `asset_holding`, `location`  |
| 4  | `v_asset_available`       | `asset_holding`, `liquidatable`, `location`   |
| 5  | `v_deployment_feasibility`| `deployment`, 2, 4, `control_panel`           |
| 6  | `v_booth_status`          | `station`                                     |
| 7  | `v_ward_eo`               | 1, 3, 6, `iec_result`, `control_panel`        |
| 8  | `v_priority_rank`         | 1, 2, 3, `control_panel`                      |
| 9  | `v_campaign_eo`           | 7, 4                                          |
| 10 | `v_float_balance`         | `float_ledger`, `app_user`                    |
|    | `mv_campaign_extract`     | 7, 8, 2, 6, 4                                 |

## Setup

```
createdb venom
for f in db/migrations/*.sql db/views/*.sql db/extract/*.sql; do
  psql -d venom -v ON_ERROR_STOP=1 -f "$f"
done
psql -d venom -f db/test/001_seed_three_wards.sql   # optional fixture
```

PostgreSQL 16. The stack uses materialised views, `FILTER` aggregates and
`LISTEN`/`NOTIFY`; none of these exist in MySQL, so XAMPP's database is not a
target.

## Ingestion

TypeScript, Node 20+. Fetchers write only to `raw.fetch`; a separate
promotion step validates and upserts into the canonical tables.

```
cp .env.example .env     # IEC credentials from webmaster@elections.org.za
npm install && npm run build
npm run ingest:baseline  # staging only, writes no canonical table
npm run promote          # staging -> canonical, refresh extract, NOTIFY
npm run verify:promotion # offline check against known payloads
```

Two things about the IEC API worth knowing before reading the code:

**National results have no ward endpoint.** `LGEBallotResults` goes down to
ward, but `NPEBallotResults` stops at voting district. Ward-level 2024
figures are summed from the VDs the delimitation assigns to each ward.

**Party names are never substring-matched.** `"DEMOCRATIC ALLIANCE"` contains
`ANC`; `"AFRICAN NATIONAL CONGRESS"` does not. Matching is exact, against the
IEC party ID where known and otherwise the full name or abbreviation, and a
configuration that matches nothing aborts the run rather than writing zero
votes for every ward. See `src/ingest/parties.ts`.

Promotion never writes campaign-entered columns — `zone`,
`candidate_status`, the `m1`-`m5` capacity fields, and everything reported at
a station. An ingest run must not erase what the organisers reported.

## Status

Schema, ten views and the extract: written, running, verified against a
three-ward fixture with hand-computed expected values in `db/test/`.

Ingestion: IEC client and promotion written, typechecked, and verified
end to end against staged payloads with no network.

**Not built yet:** the two authenticated write forms, the API, and the
dashboard. No real data is in the system — both fixtures are synthetic, and
nothing has run against the live API because the credentials are not issued
yet.

Nothing is tuned to Gauteng yet. `control_panel.swing_threshold_share`
especially needs calibrating against the real baseline once it loads.

## Build order

Start with `v_ward_computed` and `v_ward_reliability`. Everything downstream
is arithmetic on those two. If they are right on three wards whose ground
truth you know, the rest is mechanical — which is what `db/test/` is for.

## Scope boundary

No voter-level data: no person table, no contact history, no canvassing queue.
Supporter identification is a separate system with its own consent
obligations.

No donor reconciliation. `v_float_balance` reports issued, accounted, and the
gap. It is an internal control and does not discharge party funding
disclosure obligations.
