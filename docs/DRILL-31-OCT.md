# Drill 2 — 31 October: result-slip capture

**Four days before the election.** The 29th tested the reporting loop. This
one tests the path that cannot be re-run: photograph → upload → two
transcriptions → agreement or dispute.

If the reporting loop fails on 4 November you lose visibility for a few hours.
If slip capture fails you lose the counts, and they do not come back. The IEC
publishes its own results; what you cannot reconstruct afterwards is what was
written on the door at 23:00, which is the only thing that can contradict a
declaration.

---

## The thing this drill is really testing

Not the software. **Whether a marshal photographs every slip their station
produces.**

A voting station does not produce one result slip:

| Municipality type | Ballots | Stations nationally |
|---|---|---|
| Category A — metro | 2 (ward, municipal PR) | 5,070 |
| Category B — local municipality | 3 (+ district PR) | 18,681 |

**66,183 slips, not 23,751.** A marshal who photographs the ward slip and
walks away has done a third of the job in most of the country. The capture
page states the number before the list for exactly this reason, but a screen
saying "THREE ballots" and a tired person at midnight are two different
things, and this drill is how you find out which one wins.

---

## Before the day

1. **Load the roster and issue links.** Logistics → *Who may report* → paste
   the volunteers. A capture token is issued with each row automatically.
   Then use **Copy** in the Slip link column and send each person their own
   link over WhatsApp. The link is personal: it identifies them, and it is
   the only credential — there is no password.
2. **Pick stations that include category B.** At least half the volunteers
   must be on local-municipality stations, or the three-ballot trap never
   fires and you learn nothing about the failure that matters most.
3. **Print the mock slips.** `docs/drill-slip.html` — open in a browser and
   print. One sheet per ballot per station. Without these there is nothing to
   photograph, because real slips do not exist until the 4th.
4. **Arrange two HQ operators.** Transcription needs two different people;
   one person cannot do both passes, and the system will refuse to let them.
5. **Do not tell anyone about the seeded faults.**

### A word on the mock slips

They are marked DRILL in large type and carry a fictional station. Keep them
that way. Do not produce anything that could be mistaken for a real result —
destroy or clearly mark every copy afterwards, and never photograph a real
IEC document for practice.

---

## The marshal card

Send this with their personal link.

> **Photographing the result slips**
>
> When counting is finished, the result slips are posted at the station. Open
> your personal link and photograph **every slip your station has**.
>
> Your station will show you how many. **Most stations outside the big metros
> have three.** The page lists each one — ward, municipal PR, district PR —
> and marks them NEEDED or RECEIVED. Do not stop until all of them say
> RECEIVED.
>
> For each one: tap **Photograph**, take the picture, wait for the green
> confirmation.
>
> - Get the whole slip in frame, including the totals at the bottom.
> - Steady light beats a flash at an angle. If the numbers are not readable
>   to you, they will not be readable to the person typing them.
> - If it fails, tap Photograph again. Sending the same picture twice is
>   safe — it is not counted twice.
> - Do not send slips by WhatsApp. They must go through the link.

---

## The HQ operator card

**Your screen:** Result slips.

Slips arrive in a queue. You will be handed one at a time, with the
photograph on the left and the entry form on the right.

| What you see | What it means | What you do |
|---|---|---|
| **PASS 1** banner (yellow) | Nobody has read this slip | Type every party line exactly as printed, then spoilt and total votes cast. |
| **PASS 2** banner (green) | Someone has already read it | The party names are filled in; the numbers are hidden **on purpose**. Type what you see. Do not try to remember or guess what the other person entered. |
| "Does not add up — out by N" | Party votes + spoilt ≠ total | **File it as the slip reads.** Do not adjust a number to make it balance. A slip that does not add up is the finding. |
| A party on the slip that is not listed on pass 2 | The first pass missed a line | Use **Add a party line**. This is one of the errors double entry exists to catch. |
| A photograph you cannot read | Not your problem to solve by guessing | Click the image to open it full size. If it is still unreadable, Skip and tell the coordinator — the marshal must retake it. |

**You cannot edit a filed pass.** A correction is another pass. This is
deliberate: if a disagreement could be resolved by changing one side, entering
it twice would prove nothing.

---

## Seeded faults

Five. Tell nobody.

1. **The three-ballot trap.** Give at least three volunteers category B
   stations and three mock slips each, and say nothing about how many to
   send. **Expected:** they send all three. *This is the single most
   important result of the drill.* If they send one, the instruction card is
   not working and you have four days to fix it — which is why this drill is
   on the 31st and not the 3rd.
2. **A deliberate mis-transcription.** Tell one operator privately to mistype
   one number on one slip. **Expected:** it lands in *Needs a decision*
   showing both readings side by side. If it does not, double entry is
   decorative.
3. **A slip that does not balance.** One mock slip has party votes + spoilt
   that do not equal the total. **Expected:** the operator files it as
   printed and it appears under "Slips that do not add up". **If an operator
   silently corrects it to balance, stop and retrain** — that instinct will
   destroy real evidence on the night.
4. **A revoked link.** Disable one volunteer on the roster mid-drill
   (set them off), then have them try to upload. **Expected:** refused.
5. **A missed party line.** Have the pass-1 operator omit one party entirely
   on one slip. **Expected:** the pass-2 operator notices a line on the
   photograph that is not on their form, adds it, and the slip is flagged.

---

## What success looks like

Write these down:

- [ ] Every category B marshal sent **all three** slips, unprompted: ____ of ____
- [ ] Time from photograph to appearing in the queue: ____
- [ ] The mis-transcription surfaced in *Needs a decision*
- [ ] The unbalanced slip was filed as printed, **not corrected**
- [ ] The revoked link was refused
- [ ] The missed party line was caught on pass 2
- [ ] Time to transcribe one slip, both passes: ____

**The number to watch is the last one.** Two passes per slip, at 66,183
slips, is 132,366 transcriptions. If one pass takes two minutes, that is
4,400 operator-hours — which is not a thing you have. This drill is where you
find out what the real figure is and therefore how much of the country you can
actually cover. **Decide coverage from the measured rate, not from the
ambition.** It is far better to transcribe every slip in forty wards than a
third of the slips everywhere.

---

## After

File the findings in `GOTCHAS.md`, including the per-slip transcription time
and what it implies for 4 November. If the three-ballot trap failed, fixing
the marshal card is the highest-value work left before the election — higher
than any feature.
