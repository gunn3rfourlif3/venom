# Xnith architecture

Runtime shape, the scaling model, and what the hardware actually needs to be.
Module boundaries and per-module stack are in `XNITH-SCOPE.md`.

---

## 1. The 500,000 number

The Todo asks for a benchmark of 500,000 concurrent users. That phrase, taken
literally, is the most expensive sentence in the document — and it describes
something the system does not need to do. Worth taking apart, because the
difference between the two readings is roughly 15× the monthly bill.

### Where 500k comes from

Nationally there are **23,699 voting stations** for 4 November 2026. A fully
staffed ground operation puts somewhere between 5 and 20 of our own people at
or around each one:

| People per station | Total ground resources |
|---|---|
| 5 | 118,000 |
| 10 | 237,000 |
| 20 | 474,000 |

So 500,000 is a sensible ceiling for **registered devices** at full national
saturation. As a design target it is reasonable. As a concurrency target it is
a category error.

### Registered is not active is not concurrent

The reporting cadence in the addendum is one report per marshal every two
hours. Run that through:

- Registered devices: **500,000**
- Active on election day (~80%): **400,000**
- Reports per device per day (07:00–21:00, 2-hourly): **7**
- Total writes on the day: **2.8 million**
- Average write rate across the day: **~56 writes/second**
- Peak, if 80% of a cycle lands in a 5-minute window: **~1,070 writes/second**

One Postgres instance on the existing 6-core box handles 1,000 small inserts
per second without breathing hard, and a queue in front of it makes the burst
shape irrelevant. **The write load is not the problem and never was.**

### The reading that costs 15×

"500,000 concurrent" usually gets implemented as 500,000 simultaneously held
connections — WebSocket or SSE, so every marshal's phone has a live socket to
the command centre. That changes the engineering completely:

- 500,000 open sockets at 10–50 KB of kernel and heap each: **5–25 GB of RAM
  spent purely on holding connections open**
- File-descriptor ceilings, ephemeral port exhaustion, load-balancer
  connection limits, all hit at once
- A pub/sub fan-out tier, because every state change must reach a subset of
  half a million listeners
- Realistically 10–25 app nodes with tuned kernels, plus the fan-out layer

All of that to deliver a few hundred bytes to each phone a few times a day.

### The design decision that removes the problem

**Ground resources never hold a live connection.**

A marshal's phone does three things: POST a report, receive a push
notification, and poll for assignments every few minutes. Push delivery is
FCM's and APNs' problem, not ours — and they are built for exactly this fan-
out. Polling at a 5-minute interval across 400,000 devices is ~1,300
requests/second of cacheable, mostly-304 traffic, which a reverse proxy
absorbs without reaching the application.

**Only the command centre holds live connections** — the SSE path that already
exists in `src/api/live.ts`. That is hundreds of people, not hundreds of
thousands.

### The honest targets

| Dimension | Target |
|---|---|
| Registered devices | 500,000 |
| Active on election day | 400,000 |
| Peak write rate | ~1,100/sec |
| Peak HTTP requests/sec (incl. polling) | ~2,500/sec |
| Concurrent live (SSE) connections | 200–500, command centre only |
| p95 read latency on the command view | < 400 ms |
| Data loss tolerance on a submitted report | zero — queue before ack |

That is a three-node application tier and one well-provisioned Postgres. Not a
cluster.

### And for 4 November 2026 specifically

On this election the ground reports arrive **by WhatsApp**, and HQ operators
paste them into the form (`ELECTION-DAY-PLAN.md` explains why). So the actual
election-day load is:

- **Tens** of authenticated HQ operators
- A few hundred live command-centre connections
- A few thousand writes per hour, in batches

The existing 6-core / 12 GB VPS is not remotely the constraint. **The 500k
benchmark is a 2027-and-beyond problem.** Build toward it; do not provision
for it this month.

---

## 2. Runtime shape

Deliberately boring. Every piece here is something one engineer can reason
about at 03:00 on election night.

```
                     ┌─────────────────────────────┐
  phones ──────────► │  Caddy (TLS, rate limit,    │
  browsers ────────► │  static, response cache)    │
                     └──────────────┬──────────────┘
                                    │
                     ┌──────────────▼──────────────┐
                     │  Node/TS app (stateless)    │  ← scale horizontally
                     │  src/api — HTTP + SSE       │
                     └───┬──────────────────┬──────┘
                         │                  │
            ┌────────────▼──────┐   ┌───────▼─────────┐
            │  Redis            │   │  PgBouncer      │
            │  sessions, queue, │   │  transaction    │
            │  rate limits      │   │  pooling        │
            └───────────────────┘   └───────┬─────────┘
                                            │
                              ┌─────────────▼──────────────┐
                              │  PostgreSQL 16             │
                              │  raw → views → mv_extract  │
                              └─────────────┬──────────────┘
                                            │
                              ┌─────────────▼──────────────┐
                              │  Job runner (same image)   │
                              │  daily sweeps, refresh,    │
                              │  retention purge, alerts   │
                              └────────────────────────────┘
```

**Why no message broker.** Postgres with `SKIP LOCKED` is a competent queue up
to tens of thousands of jobs a minute, and it is one less system to operate.
Add a broker when a measurement says to, not before.

**Why no microservices.** The modules in `XNITH-SCOPE.md` are *schema* and
*route* boundaries inside one deployable, not separate services. One engineer
plus a two-week deadline plus distributed transactions is a bad combination.
The module boundaries are drawn so that any one of them *can* be lifted out
later — each owns its tables and talks to others through views, never by
reaching into another module's tables.

**Why stateless app nodes.** Sessions already live in Postgres
(`src/api/auth.ts`, migration 015); moving them to Redis is a config change.
That means adding a node is adding a node, with no affinity rules.

### What stays as it is

The data lineage — raw tables → computed views → one materialised extract the
dashboard reads — is the right design and does not change with scale. It is
why every figure on screen can be traced to a row and a timestamp. National
expansion makes the tables bigger; it does not change their shape.

---

## 3. Scaling tiers

Three steps, each triggered by a measurement rather than a feeling.

### Tier 0 — now, through 4 November 2026
Everything on the existing VPS, in one isolated Docker stack.
- 1 app container, 1 Postgres, 1 Redis, Caddy
- Resource-limited so it cannot starve the other sites on the box
- **Capacity: comfortably 500+ req/s and ~2,000 writes/s.** Far beyond what
  WhatsApp-mediated reporting will produce
- **Trigger to move on:** sustained p95 > 400 ms, or Postgres CPU > 60% for an
  hour, or the provider app shipping

### Tier 1 — provider app launch, national
- Managed Postgres (HA, automated backups, PITR) — moved off the VPS first,
  because the database is the part you cannot rebuild from git
- 2–3 app containers behind the load balancer
- Redis for sessions, queue and rate limiting
- Object storage for result-slip photos and uploads, served via CDN
- **Capacity: the honest targets in §1.** Headroom to roughly 2× them
- **Trigger to move on:** > 3,000 req/s sustained, or multi-region need

### Tier 2 — the 500k ceiling, election day at full saturation
- 5–8 app nodes, autoscaled on request rate
- Postgres with 1–2 read replicas; reads of `mv_campaign_extract` and the
  logistics views go to replicas
- Partition `booth_report` by date — it is append-only and time-ordered, which
  is exactly the case partitioning is for
- Push via FCM/APNs; still no persistent sockets to ground devices
- CDN in front of everything cacheable

**The important economic point:** peak load is *one day a year*. Provisioning
Tier 2 permanently to survive 4 November is paying for 365 days of capacity to
use 1. Run Tier 1 year-round and scale to Tier 2 for the week around an
election. On any hourly-billed provider that is roughly 2% of the annual cost
of standing Tier 2 up permanently.

---

## 4. Server options, with costing

You mentioned a server spec another AI produced, at
`C:\Users\verno\OneDrive\Desktop\Venom`. I cannot read your Desktop from
here — paste it or attach it and I will diff these three against it properly
rather than guess at what it said.

Costs below are **indicative monthly ranges, not quotes.** Provider pricing
moves and I have not priced these against live rate cards; treat them as
shape, and see `OPEN-QUESTIONS.md` Q11 where firming them up is tracked.

### Option A — Staging on the existing VPS, production deferred
*6 vCPU / 12 GB / 200 GB, shared with your other sites*

| | |
|---|---|
| **Cost** | Already paid for. Marginal cost ~R0 |
| **Good for** | Everything through 4 November. Staging indefinitely |
| **Pros** | No new spend. One box to understand. Full root control. Docker isolation is adequate for staging |
| **Cons** | Shares fate with your other sites — one bad deploy can affect zaaka.io and Locare. No HA. Backups are your job. 200 GB fills up once you store result-slip photos |
| **Verdict** | **Correct choice right now.** Do this. Revisit when the provider app ships |

### Option B — Dedicated VPS + managed Postgres
*One 8 vCPU / 16 GB app VPS, plus a managed Postgres instance*

| | |
|---|---|
| **Cost** | ~$25–60 app VPS + ~$60–150 managed Postgres ≈ **$85–210/mo** |
| **Good for** | Provider app launch, national scope, up to the honest targets in §1 |
| **Pros** | The database stops being your problem — HA, PITR, automated backups, version upgrades. Blast radius separated from your other sites. Still one app box to reason about |
| **Cons** | Real monthly spend. Managed Postgres is the dominant line item. Single app node is still a single point of failure |
| **Verdict** | **The right first paid step.** Move the database before you move anything else |

### Option C — Production tier for the 500k ceiling
*Load balancer + 3–8 app nodes + managed Postgres HA with replicas + Redis + object storage + CDN*

| | |
|---|---|
| **Cost** | ~$15–30 LB + $75–240 app nodes + $150–400 Postgres HA + $15–40 Redis + $10–50 storage/CDN ≈ **$265–760/mo**, higher while scaled for an election week |
| **Good for** | Election day at full national saturation with the provider app live |
| **Pros** | Meets the §1 targets with headroom. No single point of failure. Scales on demand |
| **Cons** | Most expensive by a wide margin. Needs real operational discipline — this is the tier where the DevOps agent stops being a nice idea and becomes necessary. Over-provisioned 364 days a year unless you scale down between elections |
| **Verdict** | **Not yet.** Design toward it; adopt it the month before it is needed, not the year |

### On "improve it for speed, stability, security"

Whatever the other spec says, these are the changes that matter most, roughly
in order of benefit per hour spent:

**Speed**
1. `mv_campaign_extract` already does the expensive work once — keep that
   discipline for every new aggregate. No screen computes a figure at request
   time
2. PgBouncer in transaction mode. Node's pool plus Postgres' per-connection
   cost is the first wall you hit, and it arrives earlier than people expect
3. Cache at Caddy, keyed on role. The command view is the same bytes for every
   user with the same role for 30 seconds
4. Index to the query, then verify with `EXPLAIN (ANALYZE, BUFFERS)`. The
   logistics views are small now; they will not be at 23,699 stations

**Stability**
1. **Rehearse a restore.** An untested backup is not a backup. This is the
   single highest-value hour in this document
2. Health checks that query Postgres, not ones that return 200 from the
   process. A node that cannot reach the database must leave the pool
3. Resource limits on every container, so no one service can starve the box
4. Statement timeouts and a connection cap per role. One runaway query must
   not take the election-day system with it
5. Append-only where the record matters — `booth_report` already enforces this
   with a trigger, not a comment

**Security**
1. Postgres publishes **no** host port. Only the app's internal Docker network
   reaches it. (`DEPLOY-VPS.md` does this)
2. Separate database roles per concern, with the app role unable to DDL
3. POPIA retention actually executed, not merely recorded — `npm run
   retention:purge` runs nightly from the daily job
4. Secrets in a file with `0600`, never in the image, never in git. Add a
   secret manager at Tier 1
5. Rate limit by account and by IP on every write route. The paste endpoint
   especially — it is the one authenticated endpoint that writes in bulk
6. Audit log for privileged reads. The call sheet serves phone numbers; who
   read it and when should be answerable
7. `fail2ban`, `ufw`, unattended security upgrades, SSH keys only, no root
   login

---

## 5. Where personal data lives

Xnith's governing rule is **"issues, not people"** — enforced by CHECK
constraints in migration 013, which reject anything looking like an ID number
or a phone number in a grievance summary. National expansion does not relax
it.

There are exactly three places personal data is held on purpose, and each one
is **our own people**, not the public:

| Where | What | Lawful basis | Expiry |
|---|---|---|---|
| `app_user` | Staff accounts | Employment / engagement | Account closure |
| `booth_report.reporter_phone`, `station.marshal_phone` | Marshal contact | Consent, given to be contactable on shift | `retention_until`, 180 days, purged nightly |
| Provider app (future) | Driver identity + location | Explicit consent at registration | **Open — see below** |

**The driver tracking in the Todo is the sharpest POPIA edge in the whole
project** and it needs deciding before a line of it is written. Continuous
location of an identifiable individual is among the most sensitive categories
of personal information there is, and "we needed to allocate resources" is not
on its own a complete answer.

The design that makes it defensible:
- Consent is explicit, specific and **withdrawable in the app**, not buried in
  a registration tick-box
- Location is captured **only while on an accepted assignment** — not
  background, not all day, not between shifts
- Stored **snapped to a route segment**, not as a raw GPS trail. Resource
  allocation needs to know a driver is on the N1 near Midrand; it does not
  need a breadcrumb trail of their day
- Retention measured in **days**, auto-purged by the same job that clears
  marshal phones
- Raw traces never reach the analytics layer or the materialised extract

That is in `OPEN-QUESTIONS.md` as Q6 and it is a decision for you, not a
default I should pick.

---

## 6. Observability

Not optional on a system whose whole job is visibility.

- **Structured logs** — JSON lines, request id on every line, shipped off the
  box so a dead box is still diagnosable
- **The four numbers on one screen**: request rate, p95 latency, error rate,
  Postgres connection count. If one dashboard exists, this is it
- **Election-day board**: reports ingested per hour, stations reporting vs
  silent, alert delivery success rate, queue depth
- **Synthetic check** every 60s from outside the VPS — login, load the command
  view, assert a known figure. External, because the most useful alert is the
  one that fires when the box is unreachable
- **Alert on symptoms, not causes.** "The command view is slow" wakes someone
  up; "CPU is 80%" does not
