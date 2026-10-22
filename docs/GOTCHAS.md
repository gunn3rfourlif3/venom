# Gotchas

Things that have already bitten, and things positioned to. This is the file
the DevOps agent will later read as its memory, which is the reason to keep it
now rather than start it when the agent is built. One entry per incident, with
the fix, because "we hit this before" without "and here is what fixed it" is
just a bad memory.

---

## Open traps — not yet bitten

### G1 · Renaming the repository mid-build
The product is now Xnith; the repository is still `venom`. Renaming on GitHub
is safe in itself — GitHub redirects old remote URLs indefinitely — but a
rename during a feature freeze means every local clone, deploy script, CI
reference and container label needs checking in the fortnight when you can
least afford to check things.
**Do:** rename after 4 November. Change product naming in the UI and docs now;
leave the git remote alone.

### G2 · Ward boundaries change every delimitation — this is the big one
Wards were redrawn for 2000, 2006, 2011, 2016, 2021 and again for 2026. **Ward
42 in 2016 is not Ward 42 in 2021.** Any query that joins results across
election years on `ward_id` produces a number that looks exactly like a trend
and is an artefact of the boundary moving.

This is the single most likely source of a confidently wrong figure in the
system, because it fails silently, produces plausible output, and nothing in
the data announces the problem.
**Do:** store every result against a delimitation vintage. Make cross-vintage
comparison impossible without an explicit crosswalk — a view that refuses, not
a convention people remember. Carry the interpolation uncertainty into any
figure derived through it.

### G3 · 200 GB fills up on photographs, not on rows
Signal rows and booth reports are tiny. Result-slip photos are not: 23,699
stations × a few MB is tens of gigabytes per election, and the VPS has 200 GB
shared with everything else.
**Do:** result-slip images go to object storage from the first version, not to
the local filesystem "for now". Store a key in Postgres, never a blob.

### G4 · Alert storms at 07:05
Every station is `NO_REPORT` before the first reporting cycle lands. A naive
alerting rule fires ~23,699 times at 07:05 on election day, everyone mutes
notifications by 07:10, and the alerting system is then worse than not having
one — because people believe it is working.
**Do:** suppress `NO_REPORT` until a station's first expected cycle has passed;
alert on *aggregate* blindness ("412 stations have not reported") rather than
per station; deduplicate per station per window; rate-limit globally.

### G5 · A single HQ operator is a single point of failure
The whole reporting loop on 4 November runs through one person pasting into one
form on one machine.
**Do:** two trained operators, two machines, and a written paper fallback
decided in advance. Tracked as `OPEN-QUESTIONS.md` Q5.

### G6 · Background location is impossible in a PWA
A web app cannot track a driver with the screen off. This is a platform
limitation, not a framework choice, and no amount of service-worker work
changes it.
**Do:** PWA for marshals and most providers; native, store-distributed app for
drivers only. Do not promise driver tracking on a web build.

### G7 · APK distribution — corrected, and the real trap is updates
**This entry originally said not to sideload. That advice was weaker than
stated and is withdrawn.** Recording the correction rather than quietly
editing it, because a gotchas file that hides its own mistakes is not much of a
memory.

What is actually true as of October 2026: Google's developer-verification
enforcement began 30 September 2026 in **Brazil, Indonesia, Singapore and
Thailand only**, and only for apps from seven participating app stores. Direct
APK downloads are not subject to it anywhere yet; global expansion is planned
for 2027 with no announced date. **South Africa is unaffected**, so APK
distribution works for 4 November.

And there is a positive argument that was missed: Google Play restricts
background location to apps where it is core functionality, reviews each case,
and does not guarantee approval. A party app tracking volunteer drivers is
exactly the submission that draws scrutiny on an unpredictable timeline.
Sideloading takes that review off the critical path.

**The genuine trap is the update channel, not the install.** A sideloaded APK
never auto-updates. Ship a bug on 2 November and every device runs it until
each user manually reinstalls.
**Do:** build the in-app updater *with* the first release — version endpoint, a
`minimum supported version` that blocks clients too old to trust, hash
verification before install. That field is the only kill-switch a sideloaded
fleet has.
**Also do:** register as a verified developer now ($25, Android Developer
Console) ahead of the 2027 expansion, publish the APK's SHA-256 on the download
page, and pin the signing certificate server-side so a repackaged clone cannot
talk to the API.

### G7b · Losing the keystore is unrecoverable
Sign every release with the same key. Lose it and the app can **never** be
updated again — users would have to uninstall and install a differently-signed
build, which on a volunteer workforce means losing them.
**Do:** two copies, one offline, password stored separately. This is the only
unrecoverable mistake available in the whole provider-app plan.

### G8 · Scheduled task on the wrong machine
The database runs on the VPS. A scheduler that fires somewhere else — a
cloud-side cron, an agent session — cannot reach it. Sweeps must run where the
database is, or through a published API, never by assuming network reach.
**Do:** `systemd` timer on the VPS (`DEPLOY-VPS.md` §7). For local development
on Windows, a Scheduled Task calling `npm run daily`.

---

## Bitten, and fixed

### G9 · Migration 024 made a fresh clone unmigratable
`press_title.demarcation_code` had a foreign key to `municipality`, and the
migration inserted 22 titles referencing municipalities that only exist after
`sources:official` has run. On a populated database it applied cleanly; on a
fresh clone the schema refused to build until real data had been fetched —
backwards, and invisible until someone set up from scratch.
**Fixed:** dropped the foreign key. The mapping is editorial and fixed (the
Randburg Sun covers Johannesburg whether or not Johannesburg is loaded); the
inner join in `enabledTitles()` is the real gate and it is reversible.
**Lesson:** a schema migration must never depend on fetched data. Test every
migration against an empty database, not only against yours.

### G10 · The same migration disabled titles permanently
024 also set `enabled = false` for titles whose municipality was not yet
loaded, with a comment saying this meant `sources:official` would "turn it on
later without an edit". Nothing ever turned it back on.
**Fixed:** removed. `enabled` is now an editorial switch only; the join handles
absence correctly and reversibly.
**Lesson:** a comment asserting behaviour is not behaviour. If the code does
not do what the comment says, the comment is a bug.

### G11 · `ON CONFLICT` against a partial unique index
Migration 020 replaced one unique key on `issue_signal` with two **partial**
indexes (one for ward rows, one for municipality rows). Seed 004 still targeted
the old key and failed with *"no unique or exclusion constraint matching the ON
CONFLICT specification"* — which on a fresh database presents as the sentiment
screen simply being empty.
**Fixed:** the statement must repeat the index predicate —
`ON CONFLICT (ward_id, category, observed_on, source) WHERE geo_level = 'WARD'`.
Postgres will not infer a partial index without it.
**Lesson:** splitting a unique constraint into partial indexes silently breaks
every existing upsert against it. Grep for `ON CONFLICT` when you do it.

### G12 · Savepoints in a batch insert loop
The booth-report batch endpoint rolled back to a savepoint that had not been
created yet on the first failing row. In Postgres, **any** error aborts the
whole transaction unless there is a savepoint to return to — so one unknown
booth number would have lost the other forty-nine reports in the paste.
**Fixed:** `SAVEPOINT` before each insert, `RELEASE` on success, `ROLLBACK TO`
on failure, and the refused rows named back to the operator.
**Lesson:** per-row error tolerance inside a transaction is savepoints or
nothing. There is no partial-failure mode by default.

### G13 · `psql` not on PATH, and `%VAR%` is not PowerShell
Setup instructions using `psql "%DATABASE_URL%"` fail twice on Windows: `psql`
is not on PATH unless the Postgres bin directory was added, and `%VAR%` is cmd
syntax that PowerShell does not expand.
**Fixed:** the Node migrator (`npm run migrate`) — no `psql` dependency, reads
`DATABASE_URL` from `--env-file`, works identically on Windows, macOS and
Linux. It also revealed that migrations after 017 had silently never run.
**Lesson:** if setup depends on a tool being on PATH, setup will fail for
someone. Ship the migrator.

### G14 · `package.json` was missing most of its scripts
`migrate`, `seed` and every `sources:*` entry were absent, so documented
commands like `npm run sources:press` did not exist — which would have made the
daily cadence unschedulable.
**Fixed:** all scripts added, plus `daily` and `retention:purge`.
**Lesson:** if a document names a command, run it before shipping the document.

### G15 · A retention column that nothing acted on
`booth_report.retention_until` was added with the POPIA intent of expiring
marshal phone numbers. A date column that no job reads is not a retention
policy; it is a date.
**Fixed:** `npm run retention:purge`, run nightly from `npm run daily`. It
clears the phone and keeps the report, because the queue length at 09:00 in
Katlehong is operational history and the contact number is not.
**Lesson:** every retention rule needs an executing job, and the job needs to be
in the scheduler before the feature is called done.

### G16 · Disabling a trigger to let one job through
The first version of the retention purge ran
`ALTER TABLE ... DISABLE TRIGGER`, which takes an `ACCESS EXCLUSIVE` lock and
leaves a window where the append-only guard is simply off.
**Fixed:** the trigger function itself permits exactly one update — expired
row, phone cleared, every other column byte-identical, verified by copying the
row and comparing wholesale. Nothing has to be switched off.
**Lesson:** a guard with an off switch is a guard with a window in it. Encode
the exception in the guard.

### G17 · Spec defects in the logistics addendum
Four, all corrected in migration 025 and all of the kind that only appear when
you check a spec against the live schema rather than reading it:
- `station_id integer` against a `text` primary key — the foreign key would not
  have been creatable
- Deployments are per **ward**, so one failed drop would have flagged every
  station in that ward as `SUPPLY_BROKEN`
- `expected_people * 0.5` with a NULL `expected_people` made the whole presence
  `CASE` NULL and fell through to `STAFFED` — a station with two people and no
  plan read as fully staffed
- "Never update, never delete. This is the audit trail" was asserted in a
  comment and enforced by nothing

**Lesson:** run `\d <table>` against every table a spec claims to extend,
before estimating the work.

### G18 · CSS faults only a screenshot reveals
A run of layout bugs that all typechecked, all passed review, and were all
plainly wrong on screen: a stale `margin-left: auto` pushing the rail 35 px out
of its own grid column; `.qbar-track` as a `<span>`, so `height` was ignored;
an unscoped `.pane` rule giving every single-column screen a 19 rem sidebar;
`.is-empty .viz` hiding the entire sentiment screen because `.viz` is the
container the empty-state notice lives in; the progress bar tucked under the
sticky topbar by a negative margin.
**Lesson:** render the page and look at it. Typecheck does not see layout, and
neither does reading the diff.

### G19 · Heatmap contrast, and "darker is more" inverting in dark mode
In-cell text measured 2.89:1 in light mode and 2.44:1 in dark — both failing.
Separately, the caption said "darker is more", which is false in dark mode
where the ramp inverts.
**Fixed:** computed the whole ramp rather than eyeballing it, switched ink
colour at step 5 (worst case now 4.4:1 light / 3.8:1 dark), and pointed the
caption at the legend instead of asserting a direction.
**Lesson:** contrast is computable, so compute it. And any sentence describing
a colour direction must be checked in both themes.

### G20 · The WhatsApp Business *App* has no API at all
Easy to assume that having "WhatsApp Business" means automation is available.
It does not. The **App** is the free phone app — up to four linked devices,
greeting and away messages, no API access, no webhooks. The programmable
product is the **Business Platform** (Cloud API), a separate thing with its own
onboarding.
**Consequence:** automated ingest needs either a dedicated number registered
directly on the Cloud API, or coexistence on the existing number — and
coexistence onboarding requires Solution Partner or Tech Provider status, so it
means going through a BSP.
**Lesson:** check which product a vendor name actually refers to before
planning a fortnight around it.

### G21 · Webhook replay created duplicate reports
Meta delivers webhooks **at least once** and retries on any non-200. The first
version of the handler inserted the booth report, *then* did the dedupe insert
with `ON CONFLICT (wamid) DO NOTHING`, then committed. On a retry the report
insert succeeded, only the audit row conflicted, and the commit left a
duplicate report behind with nothing pointing at it. Three deliveries of one
message produced three reports.
**Fixed:** on conflict, `ROLLBACK` instead of `COMMIT`. Both inserts share a
transaction, so rolling back undoes the duplicate report too. Retested with
three identical deliveries: one inbound row, one report.
**Lesson:** with at-least-once delivery, the dedupe key must gate the *whole*
transaction. `ON CONFLICT DO NOTHING` followed by a commit silently keeps
whatever was written before it.

### G22 · Staff replies arrive as webhooks and look exactly like reports
In coexistence mode Meta sends a `smb_message_echoes` field carrying anything
staff typed in the Business App on the phone. Those are *our own outbound
text*, and the naive extractor — walk every change, take every message —
would have filed them as marshal reports. An HQ person typing a booth number
into a chat would have invented a report.
**Fixed:** the extractor accepts only `field === 'messages'`, and only
`type === 'text'`. Status callbacks carry no `messages` array and images carry
no `text.body`, so both fall out naturally.
**Lesson:** one webhook URL receives several unrelated event families. Filter
on the field name, not on the shape you happened to see in a sample payload.

### G23 · Automated ingest is an open write surface without an allowlist
A human pasting messages is incidentally a filter. A webhook has no judgement.
Once the reporting number is known — and thousands of marshals will know it —
anyone can send `10234 none none 0` and put a staffed booth on the command
centre's exception list on election day. On an election system that is not a
theoretical attack.
**Fixed:** two locks. `X-Hub-Signature-256` HMAC over the **raw** body proves
the request came from Meta, and `reporter_roster` proves the sender is one of
ours. A message from an unrostered number is recorded as `unknown_sender` and
never filed, and the system never replies to it.
**Note on the signature:** it must be computed over the exact bytes received.
`JSON.parse` then re-stringify does not reproduce them — key order, whitespace
and unicode escaping all move — so `readRaw()` exists alongside `readJson()`.

### G24 · Severity inference read "IEC official late" as low
The keyword list had `late` as a minor indicator, so the addendum's own example
message scored *low*. An absent IEC presiding officer is a booth that cannot
open, which is as high as it gets.
**Fixed:** `iec`, `presiding officer`, `no ink`, `no scanner` and `no ballots`
added to the serious list, which is tested first. Verified that a genuinely
minor problem still reads low — "no chairs for the queue" scores `low`.
**Lesson:** keyword severity is a guess and the drills are what calibrate it.
Expect to revise this list on 29 October, and note that the operator can
override severity per line before committing.

### G34 · The silence alert fired at 100% on the day's first report
G4 keeps returning in new clothes. The widespread-silence rule counted
stations in `NO_REPORT` **or** `STALE`, guarded only by "has anything ever
been reported". So the moment the first marshal filed at 07:05, the guard
passed and the alert announced that 24,829 of 24,831 stations had "not been
heard from" — at precisely the moment reporting had begun working.
**Fixed:** the measure is `STALE` alone, against a denominator of stations
that have reported at least once. A station that has never reported has not
started; a station that reported at 09:00 and nothing since has gone quiet.
Only the second is news. Plus a floor of 20 reporting stations, because a
handful is too small a base to call a trend on.
**Verified:** 67 of 109 reporting stations stale → fires at 61%; all fresh →
silent; one report filed nationally → silent.
**Lesson:** "has it started?" and "is it working?" are different questions,
and an alert that cannot tell them apart fires hardest at the moment things
start going right.

### G35 · Dedupe by unique constraint, not by timer
The alert engine raises at most one alert per condition, per subject, per
window — enforced by a UNIQUE index on `kind:scope:bucket` and
`ON CONFLICT DO NOTHING ... RETURNING`. There is no timer, no in-memory set
of "already sent", and nothing to get out of step after a restart.
**Why it matters here:** on election day the process may well be restarted,
and an in-memory dedupe would mean every open condition re-notifying on
boot. The same pattern makes the WhatsApp webhook safe against Meta's
at-least-once redelivery (G21), and it is worth reaching for whenever
"don't do this twice" has to survive a crash.

### G33 · A file transfer reported success and sent the old version
Twice in one session, a file was copied to the staging path, confirmed
identical there by checksum, committed to the machine — and the machine kept
the *previous* version. The transfer reported `written` both times.

The first instance cost real time: the KwaZulu-Natal province-name fix in
`municipalMoney.ts` was "delivered", rebuilt and re-run, and the register
still came back missing 924 wards. The code was right; the file on disk was
the old one. The second instance was `public/app.css` and was caught only
because the checksum was verified afterwards.

**Cause:** re-committing from a staging path already used earlier in the same
session appears to send a cached copy of what was there the first time.
**Fix:** stage under a filename not used before — `app-css-v2.txt` landed
immediately with the right checksum.
**Rule going forward:** `md5sum` on both sides after every transfer. A tool
reporting success is a claim, not evidence, and "I sent it" is not the same
sentence as "it is there". All fourteen transferred files were re-verified
after this was found.

### G36 · The restore procedure in the runbook could never have worked
`DEPLOY-VPS.md` carried `gunzip -c …dump.gz | tail -1 | pg_restore`. The
`tail -1` was meant to select the newest *file*; in that position it took the
last line of the decompressed binary archive and fed that to `pg_restore`,
which fails every time with "input file does not appear to be a valid
archive". It sat in the runbook from the day it was written.

The dump was always fine — 1.1 MB, valid, on disk. **The procedure for
getting it back was broken**, and nothing except running it would have shown
that. It would have been reached for in the one hour nobody has time to
debug a pipeline.
**Fixed:** `LATEST=$(ls -t … | head -1)` picks the file; `gunzip -c "$LATEST"`
streams the whole archive.
**Verified:** restored into a scratch database and got 4,485 wards and
23,696 stations back, matching production exactly.
**Lesson:** this is the entire argument for rehearsing a restore rather than
writing one down. A backup you have never restored is a hope, and so is a
runbook you have never run.

### G37 · A single-file bind mount silently ignores every `git pull`
`deploy-caddy-1` mounts `/home/deploy/PMS03/deploy/Caddyfile` as a **file**.
Docker binds the *inode*, not the path, and git does not edit files in
place — it writes a new file and renames it over the old one, creating a new
inode. So the host path points at the new file while the container holds the
old one, for as long as that container lives.

Measured during the Xnith deploy: host `inode=609456 size=16312`, container
`inode=609236 size=14462`. The 1,850-byte difference was the new site block.
`caddy validate` passed and `caddy reload` succeeded — against the stale
file, reporting success and changing nothing.

**Implication beyond Xnith: every Caddyfile change deployed by `git pull`
since that container was last recreated has been silently ignored.** The file
on disk and the config in memory have been diverging.
**Workaround:** recreate the container (`--force-recreate`), which re-binds
the mount.
**Real fix, for after the election:** mount the *directory* (`./:/etc/caddy/`)
rather than the file. Directory mounts follow renames correctly.

### G38 · `docker compose` in PMS03/deploy operates on the wrong file
That stack's compose file is `compose.prod.yml`, not a default name, and it
interpolates variables from `.env.prod`. A plain `docker compose up` in that
directory reads a different file and reports `no such service: caddy` — or
worse, acts on a partial stack.
**Always:** `docker compose -f compose.prod.yml --env-file .env.prod …`
**Note the shape it shares with G37 and G33:** a command that looks like it
worked and did nothing. Three separate instances of that failure mode in one
evening is a pattern worth naming — when something should have changed and
no evidence says it did, check the evidence rather than the exit code.

### G31 · The exceptions table listed 19,803 identical rows
G4 predicted this; building the screen made it visible. Before the first
reporting cycle every station in the country is `NO_REPORT`, so "stations
needing attention" rendered 400 rows (capped from 19,803) that all said the
same thing. An exception that applies to everything is not an exception, and
a screen that scrolls forever on election morning is a screen nobody reads.
**Fixed:** silence is **counted by municipality** in a band above the table —
"City of Johannesburg, 895 of 895" — and the table lists only stations where
something has actually happened: somebody reported and the news was bad,
supply failed, or a problem is serious. Asking for "No report" explicitly
still lists them, because then it is what the operator went looking for. The
band hides itself once most stations are reporting, since a silent station is
a genuine exception then and belongs in the table with the rest.
**Lesson:** design the empty and the pre-start states, not just the busy one.
The screen spends the first hours of election day in exactly this condition.

### G32 · The client was downloading 400 rows to discard 397
The same screen filtered exceptions in the browser after fetching whatever
sorted first — 172 KB of station rows, of which three qualified.
**Fixed:** `?mode=exceptions` filters server-side. Payload 172 KB → 6.7 KB.
**Worth knowing:** the round trip only improved from ~590 ms to ~500 ms,
because the cost is not the payload — it is three separate full scans of
`v_booth_logistics` (rollup, matching count, silence rollup), each
recomputing the `DISTINCT ON` over `booth_report` across 19,803 stations.
That is above the 400 ms p95 target in `ARCHITECTURE.md`. Acceptable for a
day with tens of operators; the fix when it matters is to combine those three
into one scan or to materialise the view.

### G26 · `registered_voters NOT NULL` would have forced an invented number
The GIS API serves geography and has no voters' roll, but `ward.registered_voters`
was `NOT NULL` with no default. Loading a national ward would therefore have
required supplying a count — and 0 is not a missing value, it is a claim. A
ward with 0 registered voters propagates through every computed view as a
division by zero or an infinite turnout, and the result looks like data.
**Fixed:** the column is nullable. NULL means "the roll has not been loaded for
this ward" and propagates to NULL rather than to a plausible lie.
**Lesson:** a NOT NULL column on a figure you cannot always obtain is a
standing instruction to fabricate one.

### G27 · One `source` column could not describe two provenances
Loading the national register refreshes a ward's *geography* from the IEC while
its `registered_voters` may still be a synthetic figure from the Gauteng demo
set. `ward.source` was one column, so it had to claim either that the row was
real or that it was synthetic, and both were half true. The ward-size heatmap
divides by that voter count, so a chart built on invented numbers would have
looked exactly as convincing as a real one.
**Fixed:** `source` now means the geography and `roll_source` means the voter
count. `v_register_coverage` counts `wards_with_real_roll` and
`wards_with_synthetic_roll` separately, because "wards with a voter count"
would be a comforting number that includes the invented ones.
**Lesson:** when a row starts acquiring fields from different places,
provenance belongs per concern, not per row.

### G28 · Fabricated ward identifiers, and duplicate geography
The Gauteng demo seed invented ward ids for the six local municipalities by
concatenating the MDB code with a sequence: synthetic Emfuleni ward 1 is
`42100001`. The real IEC ward is `74201001`. The three metros happened to use
real ids (798/799/797), so they merged cleanly when the national register
loaded — but Emfuleni, Midvaal, Lesedi, Mogale City, Merafong City and Rand
West City then appeared **twice**, once fabricated and once real.
That left 169 wards and 1,080 voting stations that do not exist, all of them
ranking in `mv_campaign_extract` beside the real ones. On election day they
would have sat in the exception list all day as booths nobody could reach,
because there is nothing there to reach.
**Fixed:** `npm run clean:synthetic` — dry-run by default, refuses to run
unless the real register is loaded (otherwise it would leave those
municipalities with no wards at all), and reversible with `npm run seed`.
**Lesson:** synthetic data must use identifiers that cannot collide with real
ones, or it must use the real ones exactly. A plausible-looking invented key is
the worst of both, because it merges silently.

### G29 · `Number(null)` is `0`, and it cost a whole national run
The argument parser read `--limit` with `Number.isFinite(Number(opt('limit')))
? … : Infinity`. When the flag is absent, `opt()` returns `null`,
`Number(null)` is **0** rather than `NaN`, and `Number.isFinite(0)` is true —
so the limit defaulted to zero. The station walk reported "2642 wards still
need voting districts; fetching 0", fetched nothing, and **exited 0**.
**Fixed:** check for `null` and empty string before converting.
**Lesson:** `Number()` coerces `null` to zero, `''` to zero and `[]` to zero.
Any default-value helper built on it has a silent zero in it. And a job that
does nothing should not exit successfully.

### G30 · A published figure conflating wards with voting districts
An earlier version of `DATA-SOURCES.md` recorded that VD and ward were
"effectively the same unit", because a published summary gave 4,488 for both.
Measurement settled it: Johannesburg ward 1 holds **eight** voting districts,
and 4,488 wards across 23,699 stations is about five per ward.
**Lesson:** two identical figures in a summary are a reason to check, not a
finding. One API call would have caught it, and eventually did.

### G25 · A source re-guessing a category it already knew
The news sweep queried per category, so the category was known before the
response arrived — then scored the text and overwrote it, filing 26 Emfuleni
items under "Other".
**Fixed:** source-known category wins — `item.category ?? verdict.category`.
Re-running produced exactly the eight categories searched.
**Lesson:** do not infer what you were told.

### G39 · A file transfer that silently rewrote an SVG
`favicon.svg` left the container as 451 bytes and arrived on the Windows
machine as **8,225 bytes** with an `xmlns:c2pa` namespace: the transfer path
treated the `.svg` as an image and embedded a C2PA content-credentials
manifest. The commit call reported `"rejected":[]`. The file still rendered,
so nothing would have looked wrong — a favicon eighteen times larger than it
needs to be, fetched on every page load, carrying provenance metadata nobody
asked for.
**Fixed:** wrote the file directly over the device shell with a heredoc,
which does not pass through image handling. Checksum then matched.
**Lesson:** this is the fourth time in this project a transfer reported
success and delivered different bytes (see G33, G37). The four text files in
the same call arrived intact; only the one the pipeline recognised as an
image was altered. **Checksum both sides of every transfer** — and note that
"it renders" is not verification, because a rewritten file usually still
works. Prefer the device shell for binary or image-adjacent assets.

### G40 · A runbook describing a machine that was never built
`DEPLOY-VPS.md` was written from the deployment *plan*: a dedicated `xnith`
service user with the app under `/opt/xnith`. The deployment that actually
happened ran as `deploy` out of `~/xnith`, with `compose.yaml` and `.env` in
`deploy/`. Nobody noticed, because the deploy was done by following along
interactively rather than by reading the document.

29 references to `/opt/xnith` and 17 to `sudo -u xnith`. **Every command in
the runbook failed** — `cd: no such file or directory`, `sudo: unknown user
xnith` — and the `curl` at the end still returned `{"ok":true}` from the
container that was already running, so the deploy looked like it had worked.

Worse: the day before, I had "fixed" section 12 by adding an `--env-file`
flag to those commands. I corrected a detail in a procedure whose every line
was wrong, without running it — the same mistake as G36, where the restore
procedure could never have worked and only a rehearsal found it.

**Fixed:** reconciled the document to the real layout; dropped an inline copy
of `backup.sh` that had drifted from the repo's version; noted that compose
must run from `~/xnith/deploy` and auto-loads `.env` there.
**Lesson:** a runbook is only as good as its last rehearsal. `systemd/` and
`backup.sh` were right all along because they are *executed*; the prose was
wrong because it is only *read*. Anything describing a command should be run
from the document, start to finish, on the real box — and a health check
that passes after a failed deploy proves nothing.
