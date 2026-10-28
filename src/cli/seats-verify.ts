/* Runs the seat engine against published 2021 results.
 *
 *   npm run seats:verify
 *
 * Exits non-zero on any mismatch. The rule this exists to enforce: if the
 * engine cannot reproduce an election that already happened, it does not
 * get used to talk about one that has not.
 *
 * It also exercises the excess-seat path on a constructed case, so that
 * path is at least executed and its output inspected - which is weaker
 * than validation and is reported as such.
 */

import { allocate } from '../seats/allocate.js';
import { FIXTURES } from '../seats/fixtures.js';

let failures = 0;

for (const f of FIXTURES) {
  const got = allocate(f.input);
  const lines: string[] = [];

  if (f.expectedQuota !== undefined && got.quota !== f.expectedQuota) {
    lines.push(`  quota: got ${got.quota}, expected ${f.expectedQuota}`);
  }

  for (const p of got.parties) {
    const wantTotal = f.expectedTotalSeats[p.party];
    const wantPr = f.expectedPrSeats[p.party];
    if (wantTotal !== undefined && p.totalSeats !== wantTotal) {
      lines.push(`  ${p.party}: total ${p.totalSeats}, expected ${wantTotal}`);
    }
    if (wantPr !== undefined && p.prSeats !== wantPr) {
      lines.push(`  ${p.party}: PR ${p.prSeats}, expected ${wantPr}`);
    }
  }

  const seatSum = got.parties.reduce((s, p) => s + p.totalSeats, 0)
    + (f.input.independentSeats ?? 0);
  if (seatSum !== f.input.totalSeats) {
    lines.push(`  seats allocated ${seatSum}, council has ${f.input.totalSeats}`);
  }

  if (lines.length === 0) {
    console.log(`PASS  ${f.name}`);
    console.log(`      quota ${got.quota}, ${got.surplusSeats} surplus seat(s) by largest remainder`);
  } else {
    failures += 1;
    console.log(`FAIL  ${f.name}`);
    lines.forEach((l) => console.log(l));
  }
}

/* The excess-seat path, constructed. A party takes 9 of 10 wards on 40% of
   the vote - more wards than 40% of a 20-seat council entitles it to. This
   is not a validation: there is no published result behind it. It is here
   so the branch runs, the numbers can be read, and nobody discovers on
   election night that it throws. */
console.log('\nExcess-seat path (constructed, NOT validated against a result):');
const overhang = allocate({
  totalSeats: 20,
  independentWardVotes: 0,
  independentSeats: 0,
  parties: [
    { party: 'SWEEP', wardVotes: 4000, prVotes: 4000, wardSeats: 9 },
    { party: 'B',     wardVotes: 3000, prVotes: 3000, wardSeats: 1 },
    { party: 'C',     wardVotes: 2000, prVotes: 2000, wardSeats: 0 },
    { party: 'D',     wardVotes: 1000, prVotes: 1000, wardSeats: 0 },
  ],
});
console.log(`  overhangApplied: ${overhang.overhangApplied}`);
for (const p of overhang.parties) {
  console.log(`  ${p.party.padEnd(6)} total ${String(p.totalSeats).padStart(2)}`
    + `  ward ${String(p.wardSeats).padStart(2)}  PR ${String(p.prSeats).padStart(2)}`
    + (p.excess ? '   <- holds more wards than its entitlement' : ''));
}
const overhangTotal = overhang.parties.reduce((s, p) => s + p.totalSeats, 0);
console.log(`  seats accounted for: ${overhangTotal} of 20`);
overhang.notes.forEach((n) => console.log(`  note: ${n}`));
if (!overhang.overhangApplied) {
  console.log('  UNEXPECTED: the constructed case did not trigger the excess path');
  failures += 1;
}

console.log(failures === 0
  ? '\nAll published fixtures reproduced exactly.'
  : `\n${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
