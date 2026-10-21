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

### G25 · A source re-guessing a category it already knew
The news sweep queried per category, so the category was known before the
response arrived — then scored the text and overwrote it, filing 26 Emfuleni
items under "Other".
**Fixed:** source-known category wins — `item.category ?? verdict.category`.
Re-running produced exactly the eight categories searched.
**Lesson:** do not infer what you were told.
