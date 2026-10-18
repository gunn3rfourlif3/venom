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
| 11 | `v_ward_pressure`         | `ward_issue`, `service_outage`, `control_panel`|
| 12 | `v_ward_target`           | 1, 11, 8                                      |
| 13 | `v_decision_log`          | `decision`, `decision_evidence`               |
| 14 | `v_document_register`     | `document`, `document_ward`                   |
| 15 | `v_ward_dossier`          | everything                                    |
|    | `mv_campaign_extract`     | 7, 8, 2, 6, 4                                 |

## Seed data

`db/test/002_seed_gauteng_demo.sql` loads 523 wards across the nine real
Gauteng municipalities, with stations, assets, deployments and a float
ledger, so the views and the dashboard have something to run against before
IEC credentials are issued.

**Every figure in it is invented.** No vote count, turnout or registration
number in that file came from the IEC or any real election; only the
municipality names and the approximate ward counts are real, so the dataset
is a realistic size. Every ward and station row is stamped
`source = 'SYNTHETIC'`, the script refuses to run if real IEC data is
present, and nothing from it may be presented as a result or a forecast for
any actual ward. Remove it when real data lands:

```
DELETE FROM ward WHERE source = 'SYNTHETIC';
```

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

## Grievance and the repository

**Structured grievance** (`ward_issue`, `service_outage`) records what is
going wrong in a ward now. The rest of Venom measures the past and the
present inventory; neither says whether anything is moving, and in a
municipal election what moves turnout is service delivery.

`v_ward_target` crosses contestability with live pressure, which is the
thing neither signal gives alone:

| Class | Meaning |
|---|---|
| ACT NOW | Ground has come loose and something is happening on it |
| WATCH | Contestable, but nothing driving it right now |
| PRESSURE ONLY | The arithmetic writes the ward off, but it is under real pressure |
| QUIET | Neither |

PRESSURE ONLY is the row worth reading twice: 2021 and 2024 results cannot
see a grievance that started last month.

This is deliberately **not a sentiment score**. Ward-level social sentiment
is thin and badly geolocated, and a score built on it would look
quantitative while being noise. `pressure_index` is an ordinal — comparable
between wards at a point in time, not a rate or a probability.

**The repository** (`document`, `decision`, `decision_evidence`) holds what
the campaign knows and what it decided. A decision carries its rationale,
its evidence, and `model_state`: what the model said at the moment the call
was made, held inline so it stays readable after the views are rewritten.
`v_decision_log.unevidenced_flag` catches decisions with nothing attached —
not necessarily wrong, but unreviewable six weeks later.

### Issues, never people

This layer tracks grievances about **services**, never records about
**persons**. No names, contact details, identity numbers, or attributed
quotes; public sources only, never private groups. The schema enforces the
cheap part — a 13-digit run or a phone number in an issue summary is
rejected, and a document declaring personal data must carry a retention
date — and `v_document_register.retention_status` surfaces what is overdue.
The rest is discipline. Crossing this line turns campaign analytics into
profiling, with the POPIA exposure that follows, and breaks the same
no-individual-records boundary the whole design rests on.

## Tunables

Everything adjustable lives in `control_panel`, one row. Nothing is
hardcoded in a view.

Two of them are *bases* rather than numbers — the model carries both or all
three readings and the setting chooses which drives the arithmetic, so the
alternatives stay visible beside the active one:

- **`peak_basis`** — `LGE` (default) or `ALL`. Which past elections set the
  turnout ceiling. `ALL` includes national turnout, which a municipal
  election will not reach.
- **`leakage_basis`** — `OWN_VOTE` (default), `POOL_SHARE` or `ALL`. What
  the leakage term is charged against. `ALL` charges ten per cent of every
  vote cast in the ward, the rival's included; on the seeded province it
  drives 430 of 523 wards to a negative EO and is kept only for comparison.

## API

Read-only HTTP, Node 20, no web framework. Sessions are server-side so
access can be revoked the same hour somebody leaves; passwords are scrypt
from `node:crypto`. The only runtime dependency in the whole project is
`pg`.

```
node --env-file=.env dist/cli/create-user.js you@example.com "Your Name" admin
npm run api
```

| Endpoint | Returns | Role |
|---|---|---|
| `POST /api/auth/login` · `logout` | session cookie | open |
| `GET /api/wards` | ranked list, filterable by box and municipality | viewer |
| `GET /api/wards/:id` | full dossier with stations, issues, decisions, documents | viewer |
| `GET /api/targets` | contestability crossed with pressure | viewer |
| `GET /api/campaign` | the one-row balance sheet | viewer |
| `GET /api/float` | issued, accounted, shrinkage | **treasurer** |
| `GET /api/decisions` | decision log, full-text searchable | viewer |
| `GET /api/documents` | register; Restricted hidden below treasurer | viewer |
| `GET /api/ingest-health` | staleness per source | viewer |
| `GET /api/live` | server-sent events | viewer |

Four rules hold across all of it: **read-only** — every write goes through
import or the two authenticated forms; **every response carries `as_of`**,
because a figure without a timestamp cannot be defended in an argument;
**null is a real answer** — `eo_act_votes` is null until the declaration and
the client must render the absence rather than coerce it to zero; and **no
computation in the app layer** — if the dashboard needs a figure that is not
already a column, the figure belongs in a view.

### The live path is SSE, not WebSocket

The specification said WebSocket. Server-sent events are the better fit: the
channel is one-way, it is plain HTTP so it needs no dependency, the browser
reconnects on its own — which on counting night matters more than anything
else here — and it survives proxies that will not negotiate an upgrade.

What is pushed is an **identifier, never a value**. A payload of `ward_id`
alone stays under the 8 kB `NOTIFY` limit, cannot be applied out of order,
and makes the client read back through the same query it used on load.
Pushing values is the usual reason a dashboard drifts out of sync with its
database and nobody can say why.

## Dashboard

`public/`, served by the API at `/`. No build step, no framework, no
dependency: three files, and the project's runtime dependency count stays
at one.

The interface is a **ledger, not a dashboard**. The model's whole vocabulary
is accounting — potential, eroding, expected, liabilities, shrinkage, float
— so the screen is a statement with marked lines rather than a grid of
cards. Three figures sit on one shared rule because the model produces one
statement, not three metrics.

Boldness is spent in exactly one place: a ward flagged `URGENT` carries a
solid ink block in the left margin, the way a flagged entry is marked in a
physical ledger. No accent colour is spent on it. Everything else — the
box, the pressure band — is quiet and semantic.

Clicking a line opens the ward dossier: arithmetic, ledger, capacity,
liabilities, pressure, grievances, decisions and documents, read live from
the views rather than the extract.

Null renders as an em dash, never as zero. `eo_act_votes` is null until the
declaration and `reliability_ratio` is null for a zone that has never
deployed; zero and unknown mean opposite things in this model and the
interface must not collapse them.

### One bug worth recording

`.signin` and `.pane` both set `display: grid`, which silently overrides the
`hidden` attribute — the user agent applies `hidden` as `display: none`, and
any author rule setting `display` on the same element beats it. The result:
the sign-in form stayed painted over the signed-in app, and every view
stacked on every other. The DOM reported everything correct, API calls all
returned 200, and nothing appeared in the console. It was only visible in a
screenshot. `[hidden] { display: none !important; }` fixes it.

## Scope boundary

No voter-level data: no person table, no contact history, no canvassing queue.
Supporter identification is a separate system with its own consent
obligations.

No donor reconciliation. `v_float_balance` reports issued, accounted, and the
gap. It is an internal control and does not discharge party funding
disclosure obligations.
