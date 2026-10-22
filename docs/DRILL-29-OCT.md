# Drill 1 — 29 October: the reporting loop

**Six days before the election.** The second drill is 31 October and tests
result-slip capture; this one tests the thing that has never been touched by a
person with a phone — a marshal sending a station report and it arriving.

Everything in the ingest path has been verified by me, against test messages I
wrote myself, in a format I already knew. That is not evidence. The failure
this drill exists to find is the one where a real marshal types something
reasonable and the system refuses it, and nobody notices until 4 November.

---

## What this drill proves, and what it does not

**Proves:** that a person who has been given the instruction card can produce a
message the parser accepts; that the roster allowlist admits the right numbers
and refuses the rest; that reports reach the Logistics screen; that an HQ
operator can spot a silent station and act on it.

**Does not prove:** anything about volume. Ten marshals over three windows is
about thirty messages. Election day is ~166,000. This drill finds *format and
human* failures, not load failures. Do not conclude from a clean drill that the
pipeline will hold on the day.

**Meta is still uncleared (Q15),** so automated WhatsApp ingest may not be
available on the 29th. That is fine and does not postpone the drill: run it
through the paste form, with an operator transcribing what arrives in the
WhatsApp Business App. The marshal's half of the loop — the part being tested —
is identical either way. If Meta clears first, run it automated and note which
path was used.

---

## Before the day

1. **Load the drill roster.** Logistics → *Who may report* → paste the
   volunteers as `Name, 082 123 4567`, one per line. Only rostered numbers are
   accepted; this is deliberate and is one of the things under test.
2. **Pick one municipality and 20–40 real stations.** Use stations that
   actually exist in the register — a drill against invented booth numbers
   tests nothing, and inventing them is how 169 fake wards got in (G28).
3. **Send each volunteer their station list and the card below.** Send it the
   way they will receive it on the day: a WhatsApp message, not a PDF.
4. **Do not tell them about the deliberate faults.**

---

## The marshal card

Send this verbatim. It is written to be read on a phone, in a hurry, once.

> **Reporting your station**
>
> Every two hours, send one message per station. One station per line.
>
> `BOOTH  QUEUE  [problem]  [number of people]`
>
> **Booth** is the station number on your list — exactly as written.
> **Queue** is one of: `short` `med` `long` `none`
> **Problem** — only if there is one. Leave it out if all is well.
> **Number** is roughly how many people are on site.
>
> Examples:
>
> `32940015 short 120`
> `32940015 long IEC official late 85`
> `32940015 none no ballot papers 0`
>
> **You must send a number, or a problem, or both.** `32940015 short` on its
> own will be rejected — it does not say anything.
>
> Several stations in one message is fine, one per line:
>
> `32940015 short 120`
> `32940021 med 240`
>
> You will get a reply confirming it was logged. If nothing comes back within
> ten minutes, send it again — a repeat is safe, the system discards
> duplicates.

### Why the card says what it says

- **"You must send a number, or a problem"** — the parser rejects a line with
  neither, because a queue length alone reports nothing. This is the single
  most likely thing a marshal gets wrong, so it is stated twice.
- **"exactly as written"** — the booth number is the field where a wrong value
  misfiles silently instead of failing visibly.
- **"a repeat is safe"** — true, and worth saying: the deduplication is by
  message ID, verified (G21). Marshals who fear double-reporting under-report.
- The card does **not** mention result slips. That is the 31st.

> **If you are running the paste-form path, delete the reply paragraph from
> the card before you send it.** Acknowledgements go out through Meta's Graph
> API, so on the manual path nothing replies to anyone. Leave the paragraph in
> and every marshal waits ten minutes, concludes it failed, and re-sends —
> repeatedly. You would be measuring your own instruction, and drowning the
> operator while you did it.
>
> On the manual path, replace it with: *"You will not get a reply during this
> drill. Send once and carry on."* Then have the operator confirm receipt by
> phone at the end of each window, so the marshals still learn whether they
> were understood.

---

## The HQ operator card

**Your screens:** Logistics for the live picture, *Ingest exceptions* for what
was refused.

| What you see | What it means | What you do |
|---|---|---|
| A station goes amber/stale | No report in the current window | Call the marshal. Note the time you called. |
| A line in *Ingest exceptions* | Message refused | Read the reason. If it is a roster refusal, check whether the number is a volunteer who changed phones. |
| A report with an odd head count | Possibly a typo, possibly real | Do **not** correct it. The table is append-only. Ask the marshal to re-send. |
| Nothing at all arriving | The pipeline, not the marshals | Escalate immediately; this is the failure the drill is for. |
| The same report three or four times | Marshals waiting on a reply that cannot come | Check you are on the manual path with the reply paragraph still in the card. |

**Record, for every window:** how many of the expected reports arrived, how
many were refused and why, and how long after the window opened the last one
came in. That last number is the one that matters — it is what tells you
whether a two-hourly cadence is actually two-hourly.

---

## Deliberate faults to inject

A drill that only runs the happy path confirms what you already believe. Seed
all four, and tell nobody:

1. **An unrostered number.** Have someone not on the roster send a
   well-formed report. **Expected:** refused, visible in *Ingest exceptions*,
   never filed as a report. If it is accepted, stop the drill — the allowlist
   is the only thing stopping a stranger who learns the number from putting a
   staffed booth on the exception list.
2. **A malformed line.** `32940015 short` with no number. **Expected:**
   refused with a reason an operator can act on, not a silent drop.
3. **A silent station.** Instruct one volunteer to send nothing in window 2.
   **Expected:** it shows as stale, and the operator notices without being
   told. If the operator does not notice, the screen is the problem.
4. **A duplicate.** Have someone send the same message three times.
   **Expected:** one report, not three.

---

## What success looks like

Write these down on the day; they are the drill's output:

- [ ] ≥ 90% of expected reports arrived in the window they belonged to
- [ ] Every refusal had a reason the operator could act on
- [ ] The unrostered message was refused
- [ ] The duplicate produced exactly one report
- [ ] The silent station was noticed by an operator, unprompted
- [ ] Last-report-in time, per window: ____ minutes

**Anything a marshal typed that the parser refused but a human would have
understood is a bug in the parser, not in the marshal.** Collect those verbatim
— they are the most valuable thing this drill produces, and there is still time
to widen the parser before the 4th.

---

## After

File the findings in `GOTCHAS.md` as a numbered entry, whatever the outcome.
A drill that found nothing is itself a finding, and should say how many
messages it was based on — so that nobody later mistakes a thirty-message
clean run for evidence the pipeline scales.
