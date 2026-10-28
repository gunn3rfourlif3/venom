/* Municipal seat allocation, per Schedule 1 of the Local Government:
 * Municipal Structures Act 117 of 1998, as amended by Act 3 of 2021.
 *
 * WHY THIS FILE EXISTS. Four of the concept briefs in Desktop\Venom\modules
 * compute municipal seats, and all four are wrong in different ways: one
 * divides by PR seats rather than total seats, one says it is "ignoring the
 * 50% ward/PR split for now", one doubles every party's votes, and one
 * asserts PR seats are allocated "completely ignoring individual ward
 * boundaries". This replaces all four with one implementation that is
 * checked against published results rather than argued about.
 *
 * THE ONE THING EVERY WRONG VERSION GETS WRONG. South African municipal PR
 * is COMPENSATORY. A party's entitlement is computed from the combined
 * ward + PR vote across the WHOLE council, and its PR seats are that
 * entitlement MINUS the ward seats it already won. Winning wards does not
 * add to your list seats, it consumes them. Read the other way - as the
 * briefs read it - a party on 77 total seats looks like 77 PR seats on top
 * of 40 ward seats. That is a 52% overstatement of the prize.
 *
 * VALIDATION. `verifyFixtures()` runs the two published 2021 results in
 * `fixtures.ts` and returns pass/fail per party. The normal path reproduces
 * both exactly. The overhang path is implemented from the amended Act and
 * is NOT yet checked against a published result - `overhangApplied` on the
 * result says when that path ran, so a projection that depends on untested
 * code says so rather than looking like the rest.
 *
 * NOT VALIDATED IS NOT THE SAME AS NOT TRUSTED, AND NEITHER IS SILENT.
 */

export interface PartyVotes {
  party: string;
  /** Votes on the ward ballot, summed across every ward in the municipality. */
  wardVotes: number;
  /** Votes on the PR (list) ballot. */
  prVotes: number;
  /** Ward seats the party actually won. */
  wardSeats: number;
}

export interface AllocationInput {
  /** Total seats on the council - ward plus PR. NOT the PR seats alone. */
  totalSeats: number;
  parties: PartyVotes[];
  /** Ward votes cast for independent candidates. Counted in the quota's
   *  numerator even though independents hold no list - leaving them out
   *  shifts the quota and changes who wins the last seats. */
  independentWardVotes?: number;
  /** Ward seats won by independent candidates. */
  independentSeats?: number;
}

export interface PartyAllocation {
  party: string;
  votes: number;          // ward + PR
  totalSeats: number;     // full entitlement
  wardSeats: number;
  prSeats: number;        // totalSeats - wardSeats, never negative
  /** True when this party won more wards than its proportional entitlement. */
  excess: boolean;
}

export interface Allocation {
  quota: number;
  seatsAllocated: number;
  surplusSeats: number;
  parties: PartyAllocation[];
  /** True when the Act's excess-seat path in item 16(3)-(6) was used. That
   *  path is implemented from the statute and not yet checked against a
   *  published result; a caller that shows these numbers should say so. */
  overhangApplied: boolean;
  notes: string[];
}

const floorDiv = (a: number, b: number) => Math.floor(a / b);

/** Largest-remainder distribution of whatever the floor division left over.
 *  Ties broken by party name so a run is reproducible; the Act leaves the
 *  tie-break to the Commission and a stable order beats an arbitrary one. */
function distributeSurplus(
  entitlement: Map<string, number>,
  remainder: Map<string, number>,
  seatsLeft: number,
): void {
  const order = [...remainder.entries()]
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));
  for (let i = 0; i < seatsLeft && i < order.length; i++) {
    const party = order[i]![0];
    entitlement.set(party, (entitlement.get(party) ?? 0) + 1);
  }
}

export function allocate(input: AllocationInput): Allocation {
  const { totalSeats, parties } = input;
  const independentWardVotes = input.independentWardVotes ?? 0;
  const independentSeats = input.independentSeats ?? 0;
  const notes: string[] = [];

  if (totalSeats <= 0) throw new Error('totalSeats must be positive');
  if (parties.length === 0) throw new Error('no parties supplied');

  const votesOf = new Map(parties.map((p) => [p.party, p.wardVotes + p.prVotes]));

  /* A is every valid vote cast on both ballots, INCLUDING votes for
     independent ward candidates. Excluding them was tested against Sol
     Plaatje 2021 and produced the wrong answer for two parties: the quota
     came out 1,840 instead of 1,865, the ANC gained a seat it did not win
     and the FF+ lost one it did. */
  const A = [...votesOf.values()].reduce((s, v) => s + v, 0) + independentWardVotes;

  // Base quota: fractions disregarded.
  const quota = floorDiv(A, totalSeats - independentSeats + 1);
  if (quota <= 0) throw new Error('quota computed as zero - check the vote totals');

  const entitlement = new Map<string, number>();
  const remainder = new Map<string, number>();
  for (const p of parties) {
    const v = votesOf.get(p.party)!;
    entitlement.set(p.party, floorDiv(v, quota));
    remainder.set(p.party, v - floorDiv(v, quota) * quota);
  }

  const seatsForParties = totalSeats - independentSeats;
  const allocatedByFloor = [...entitlement.values()].reduce((s, v) => s + v, 0);
  const surplusSeats = seatsForParties - allocatedByFloor;
  if (surplusSeats > 0) distributeSurplus(entitlement, remainder, surplusSeats);

  /* THE EXCESS-SEAT CASE (Act 3 of 2021, Schedule 1 item 16). A party can
     win more wards than its proportional entitlement. It keeps the wards -
     they were won outright - so the remaining seats are re-divided among
     everyone else against a new quota that removes that party's votes and
     its seats from the calculation entirely:
         new quota = (A - B + 1) / (C - (D + E))
     A total valid votes, B the excess party's votes, C council seats,
     D the seats awarded to that party, E independent ward councillors. */
  const excessParties = parties.filter(
    (p) => p.wardSeats > (entitlement.get(p.party) ?? 0));

  let overhangApplied = false;

  if (excessParties.length > 0) {
    overhangApplied = true;
    if (excessParties.length > 1) {
      notes.push(
        `${excessParties.length} parties hold more wards than their entitlement. `
        + 'The Act contemplates one; this run excludes all of them together, which '
        + 'is an interpretation, not a reading. Treat the result as indicative.');
    }

    const B = excessParties.reduce((s, p) => s + votesOf.get(p.party)!, 0);
    const D = excessParties.reduce((s, p) => s + p.wardSeats, 0);
    const denominator = totalSeats - (D + independentSeats);

    if (denominator <= 0) {
      notes.push('No seats remain after the excess party keeps its wards; '
        + 'every other party is allocated nothing.');
      for (const p of parties) {
        entitlement.set(p.party, excessParties.includes(p) ? p.wardSeats : 0);
      }
    } else {
      const newQuota = floorDiv(A - B + 1, denominator);
      if (newQuota <= 0) {
        notes.push('Recomputed quota was zero; the base allocation is reported instead.');
      } else {
        const rest = parties.filter((p) => !excessParties.includes(p));
        const ent2 = new Map<string, number>();
        const rem2 = new Map<string, number>();
        for (const p of rest) {
          const v = votesOf.get(p.party)!;
          ent2.set(p.party, floorDiv(v, newQuota));
          rem2.set(p.party, v - floorDiv(v, newQuota) * newQuota);
        }
        const left = denominator - [...ent2.values()].reduce((s, v) => s + v, 0);
        if (left > 0) distributeSurplus(ent2, rem2, left);

        for (const p of excessParties) entitlement.set(p.party, p.wardSeats);
        for (const p of rest) entitlement.set(p.party, ent2.get(p.party) ?? 0);

        notes.push(
          `Excess-seat path used (quota recomputed ${quota} -> ${newQuota}). `
          + 'Implemented from Act 3 of 2021 Schedule 1 item 16 and not yet '
          + 'checked against a published result.');
      }
    }
  }

  const out: PartyAllocation[] = parties.map((p) => {
    const total = entitlement.get(p.party) ?? 0;
    return {
      party: p.party,
      votes: votesOf.get(p.party)!,
      totalSeats: total,
      wardSeats: p.wardSeats,
      // Compensatory: the list tops a party up to its entitlement, it does
      // not add to it. Clamped so an overhang reports 0 rather than -3.
      prSeats: Math.max(0, total - p.wardSeats),
      excess: p.wardSeats > total,
    };
  });

  return {
    quota,
    seatsAllocated: out.reduce((s, p) => s + p.totalSeats, 0) + independentSeats,
    surplusSeats,
    parties: out.sort((a, b) => b.totalSeats - a.totalSeats || b.votes - a.votes),
    overhangApplied,
    notes,
  };
}
