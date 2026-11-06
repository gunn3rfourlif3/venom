# Tally integrity

How Xnith proves a published count was not changed after the fact.

---

## Where this came from, and why it is not what was asked for

The original idea was to encrypt a vote so live numbers could be shown
without revealing which party they belong to — so the totals could go up on
screen while the ordering stayed hidden until declaration.

**That does not work, and it is worth understanding why before relying on
anything here.**

1. **The ground truth is already public.** The IEC posts each voting
   station's result at the station, on the night. Anyone can read them and
   join them back to an anonymous feed.
2. **Nine unlabelled numbers identify themselves.** With a known party list
   and roughly known support, the magnitudes alone give the ordering away.
   There is nothing to guess.
3. **Geography finishes the job.** A per-ward or per-municipality series is
   de-anonymised by a handful of wards whose result is known.
4. **Reporting curves fingerprint parties.** Strongholds report at different
   rates; the shape of each series over the night is itself identifying.
5. **The operator holds the key.** A promise not to look is a promise, not a
   guarantee.

Encryption hides a label. It cannot hide the shape of the data, and with
election results the shape *is* the label.

So the idea was inverted. Rather than making the numbers unreadable, the
system makes them **uncontestable**. That answers the question a published
running count actually invites, which is not *whose number is this* but
*is this the number you held at 20:15, or the number you wish you had held*.

### On publishing unofficial results at all

Section 109 of the Electoral Act prohibits **exit polls** during voting
hours. It does not prohibit publishing your own tally of captured result
slips. The IEC has, however, publicly criticised parties for premature
announcements — in 2021 among others — so there is a reputational question
separate from the legal one. Nothing in this module decides that. It makes
whatever you do publish checkable.

---

## How it works

At each snapshot:

1. The current counts are read from `v_tally_vote`.
2. A random 32-byte nonce is generated.
3. `SHA-256` is computed over a plain-text canonical form of
   *(sequence number, scope, timestamp, coverage, previous digest, counts,
   nonce)*.
4. The link is appended to `tally_commitment`. **The digest is published
   now; the counts are not.**

At declaration, `tally:reveal` publishes the counts and the nonce. Anyone can
then recompute the digest and check it against the one published earlier.

Each digest includes the previous one, so the links form a chain: altering
any snapshot invalidates every snapshot after it.

### The nonce

Without it, a published digest of a national count could be confirmed against
a guessed tally — there are not that many plausible values. The nonce makes
the sealed digest uninformative until it is opened.

### The canonical form

Deliberately boring: plain text, one field per line, tab-separated, parties
sorted by name, votes as integers. **Not JSON** — key order, whitespace and
number formatting are all loose enough in JSON that two correct
implementations can produce different bytes, and a digest that depends on
whose serialiser you used is not one anyone can check.

A person with `sha256sum` and a text editor can verify a snapshot by hand.
See `src/tally/commit.ts`; `tally:commit --show-form` prints the exact bytes.

---

## What it proves, precisely

**It proves** a sealed figure was not edited afterwards — not by the
application, not by a stray migration, not by anyone with ordinary write
access to the database.

**It does not prove the count is right.** A commitment over a wrong tally is
a tamper-proof record of a wrong tally.

**It does not prove the count is complete.** Every snapshot carries its own
coverage, and on the night that will be well short of 100%.

**It does not, on its own, prove anything against us.** This is the part that
gets glossed over everywhere else and must not be glossed over here.

### The limit, stated plainly

Whoever owns the database can drop the append-only triggers, alter the
counts, **and recompute every digest** so the chain verifies perfectly. This
has been tested: a rebuilt chain passes `tally:verify` with no complaints.

A commitment held entirely by the party making the claim proves nothing
against that party.

### What fixes it

**Publishing one digest somewhere you do not control.** Once the anchor line
sits in somebody else's inbox, every link up to it is frozen — including for
you. A rebuilt chain will not contain that digest, and
`tally:verify --anchor <digest>` says so.

This costs nothing and the whole scheme is decoration without it. Export
after every seal and send it to someone with no stake in the answer: an agent
from another party, an observer, a journalist, a timestamped group message.
The recipient does not need to understand any of this. They need to keep the
message.

---

## Election-night procedure

**Seal hourly. Send an anchor three times: 20:00, 23:00, and at
declaration.**

That works because each digest contains the previous one, so the 23:00
anchor retroactively freezes every hourly seal since 20:00. Three messages
cover a night of eleven seals. Sealing is cheap and reveals nothing — the
digest is opaque until revealed — so the only real cost is sending the
anchor, and that is what the cadence economises on.

Sealing hourly regardless of whether you intend to announce anything is the
part that carries the credibility. It means you cannot have chosen which
cuts got recorded, and a gap in an hourly chain is conspicuous.

Run from the repo root on the server.

**Every hour, from 20:00:**

```
npm run tally:commit -- --scope NATIONAL --note "21:00 cut"
```

It will say `Sealed only — no need to send anything` and tell you how many
seals are riding on the next anchor. Nothing else to do.

**At 20:00, 23:00, and declaration — add `--anchor-now`:**

```
npm run tally:commit -- --scope NATIONAL --note "23:00 cut" --anchor-now
npm run tally:export -- --mark-sent "observers' WhatsApp group"
```

`--anchor-now` only changes what is printed; every seal is identical in the
chain and any of them can be anchored later. The second command prints the
line and records that you sent it.

**Send the line.** The seal is not finished until you have. To someone with
no stake in the answer: an agent from another party, an observer, a
journalist, a timestamped group message. They do not need to understand any
of this — they need to keep the message.

`--mark-sent` writes a note of where it went. **That note is a pointer, not
proof.** It exists because at 02:00 nobody remembers which of eleven lines
was the one that went out, and without that you cannot run the check at all.
Anyone who could rebuild the chain could also rewrite the note to match.

Per province or council, same pattern:

```
npm run tally:commit -- --scope PROVINCE --key "Gauteng"
npm run tally:commit -- --scope MUNICIPALITY --key NW372
```

**Checking at any point:**

```
npm run tally:verify
```

With no anchor this only asks the chain about itself, and says so. It then
names the link recorded as sent and where, so you know which message to go
and find. Open that message, copy the digest **out of the message**, and:

```
npm run tally:verify -- --anchor <the digest in that message>
```

Copying it from the screen defeats the point — a rebuilt chain would hand
you its own digest to check itself against.

**After the result is final:**

```
npm run tally:reveal -- --all
npm run tally:export -- --format md      # the full table, for a post or email
```

A reveal is permanent. There is no un-reveal: one that could be withdrawn
would let you open a favourable snapshot, see how it landed, and close it
again.

### If you miss an hour

Nothing breaks. The chain has no notion of a schedule — a gap is just a gap,
and the links either side still join up. Seal when you next can.

### If you forget to anchor at 23:00

Also nothing breaks, but everything since 20:00 is resting on this database
alone until you do. `tally:verify` says exactly how many seals are in that
state, and the screen shows each one as *not yet covered by an anchor*.

## In the app

**Tally integrity** in the sidebar. It leads with the line to publish,
because that is the only action on the screen; everything below is a record
of actions already taken.

There is deliberately **no green tick**. A chain verifying against itself
proves nothing against the people running it, and a reassuring badge would
invite exactly the trust the scheme cannot earn on its own.

The endpoint (`GET /api/commitments`) reads `v_commitment_chain`, which masks
counts and nonce until a link is revealed. That masking is the only reason
the endpoint is safe to serve.

---

## Honest caveat on secrecy

A sealed tally sits **readable in the database**. Anyone with database access
can see the numbers before they are published; the masking is at the API
boundary, not in storage.

Making it secret from your own staff too would mean computing the seal
somewhere they cannot reach, with a key-custody problem attached. That is a
different piece of work. **Tamper-evidence is the property this delivers**,
and it is the one that answers the question being asked.

"Sealed" here means: published as a digest, openable later, unchangeable in
between. It does not mean nobody can see it.

---

## Implementation

| Piece | Where |
|---|---|
| Canonical form, digest, chain verification (pure, no DB) | `src/tally/commit.ts` |
| Append-only table, triggers, public view | `db/migrations/053`, `055` |
| Deduplicated vote source | `db/migrations/054_tally_source.sql` |
| Seal / open / check / publish | `src/cli/tally-{commit,reveal,verify,export}.ts` |
| Anchor record (a pointer, not proof) | `db/migrations/056_anchor_record.sql` |
| API | `src/api/commitment.ts` |
| Screen | `#view-commitments` in `public/index.html`, `loadCommitments()` in `public/app.js` |

### The double-count bug found while building this

Every query that tallied votes joined `result_vote` to
`result_transcription` and summed. A slip gets **two** transcriptions — double
entry is the quality mechanism — so every properly verified slip was
**counted twice**. Measured, not inferred: a 500-vote slip with two agreeing
passes returned 1,000.

The overcount drifted between 1× and 2× as transcription caught up through
the night, which looks exactly like results arriving. It would have doubled
every seat projection on the 4th while appearing to behave.

Fixed in migration 054, which proves the fix by failing if the naive join
stops doubling a known fixture. **Never read `result_vote` directly — use
`v_tally_vote`.**

`npm run verify` guards against the regression once results exist.
