/* Published 2021 municipal results, used to check the seat engine.
 *
 * These are the test. An engine that cannot reproduce a result that has
 * already happened has no business projecting one that has not, and the
 * four briefs this replaces were each argued for rather than checked.
 *
 * Source: the published 2021 Local Government Election results for each
 * municipality, as summarised on the municipality's Wikipedia results page.
 * Those pages are a transcription of the IEC declaration, not the
 * declaration itself - see OPEN-QUESTIONS Q19. If a figure here is ever
 * found to differ from the IEC's own published table, the IEC's is right
 * and this file is wrong.
 *
 * Both fixtures have independents standing and winning nothing, which is
 * the common case. Neither contains an overhang, so the excess-seat path
 * in allocate.ts is NOT exercised by these. That gap is stated rather than
 * papered over.
 */

import type { AllocationInput } from './allocate.js';

export interface Fixture {
  name: string;
  input: AllocationInput;
  /** party -> total seats actually won, from the published result. */
  expectedTotalSeats: Record<string, number>;
  /** party -> PR seats actually won. */
  expectedPrSeats: Record<string, number>;
  expectedQuota?: number;
}

export const FIXTURES: Fixture[] = [
  {
    name: 'Sol Plaatje 2021 (65 seats, 33 wards, 14 parties)',
    expectedQuota: 1865,
    input: {
      totalSeats: 65,
      independentWardVotes: 1648,
      independentSeats: 0,
      parties: [
        { party: 'ANC',   wardVotes: 30837, prVotes: 30913, wardSeats: 27 },
        { party: 'DA',    wardVotes: 12591, prVotes: 12702, wardSeats: 6 },
        { party: 'EFF',   wardVotes: 5600,  prVotes: 5994,  wardSeats: 0 },
        { party: 'SPSDF', wardVotes: 2645,  prVotes: 2923,  wardSeats: 0 },
        { party: 'PA',    wardVotes: 2577,  prVotes: 2834,  wardSeats: 0 },
        { party: 'FF+',   wardVotes: 2243,  prVotes: 2096,  wardSeats: 0 },
        { party: 'GOOD',  wardVotes: 2092,  prVotes: 2099,  wardSeats: 0 },
        { party: 'ACDP',  wardVotes: 570,   prVotes: 456,   wardSeats: 0 },
        { party: 'COPE',  wardVotes: 183,   prVotes: 394,   wardSeats: 0 },
        { party: 'AZAPO', wardVotes: 274,   prVotes: 269,   wardSeats: 0 },
        { party: 'ATM',   wardVotes: 234,   prVotes: 251,   wardSeats: 0 },
        { party: 'AND',   wardVotes: 135,   prVotes: 147,   wardSeats: 0 },
        { party: 'SNP',   wardVotes: 129,   prVotes: 91,    wardSeats: 0 },
        { party: 'EEF',   wardVotes: 121,   prVotes: 64,    wardSeats: 0 },
      ],
    },
    expectedTotalSeats: {
      ANC: 33, DA: 14, EFF: 6, SPSDF: 3, PA: 3, 'FF+': 3, GOOD: 2, ACDP: 1,
      COPE: 0, AZAPO: 0, ATM: 0, AND: 0, SNP: 0, EEF: 0,
    },
    expectedPrSeats: {
      ANC: 6, DA: 8, EFF: 6, SPSDF: 3, PA: 3, 'FF+': 3, GOOD: 2, ACDP: 1,
      COPE: 0, AZAPO: 0, ATM: 0, AND: 0, SNP: 0, EEF: 0,
    },
  },
  {
    name: 'Madibeng 2021 (82 seats, 41 wards, 26 parties)',
    expectedQuota: 2153,
    input: {
      totalSeats: 82,
      independentWardVotes: 1884,
      independentSeats: 0,
      parties: [
        { party: 'ANC',    wardVotes: 47233, prVotes: 47780, wardSeats: 36 },
        { party: 'EFF',    wardVotes: 15176, prVotes: 15847, wardSeats: 1 },
        { party: 'DA',     wardVotes: 12928, prVotes: 12658, wardSeats: 4 },
        { party: 'FF+',    wardVotes: 4628,  prVotes: 4528,  wardSeats: 0 },
        { party: 'SAVEMAD', wardVotes: 2971, prVotes: 3180,  wardSeats: 0 },
        { party: 'ALJAMAAH', wardVotes: 598, prVotes: 586,   wardSeats: 0 },
        { party: 'AIC',    wardVotes: 375,   prVotes: 772,   wardSeats: 0 },
        { party: 'FSD',    wardVotes: 506,   prVotes: 520,   wardSeats: 0 },
        { party: 'UDM',    wardVotes: 528,   prVotes: 489,   wardSeats: 0 },
        { party: 'ACDP',   wardVotes: 486,   prVotes: 414,   wardSeats: 0 },
        { party: 'TCM',    wardVotes: 350,   prVotes: 504,   wardSeats: 0 },
        { party: 'UCDP',   wardVotes: 248,   prVotes: 286,   wardSeats: 0 },
        { party: 'ABC',    wardVotes: 245,   prVotes: 203,   wardSeats: 0 },
        { party: 'AMC',    wardVotes: 288,   prVotes: 149,   wardSeats: 0 },
        { party: 'IFP',    wardVotes: 26,    prVotes: 383,   wardSeats: 0 },
        { party: 'DOP',    wardVotes: 150,   prVotes: 178,   wardSeats: 0 },
        { party: 'INDPARTY', wardVotes: 170, prVotes: 119,   wardSeats: 0 },
        { party: 'ATM',    wardVotes: 86,    prVotes: 197,   wardSeats: 0 },
        { party: 'APC',    wardVotes: 177,   prVotes: 89,    wardSeats: 0 },
        { party: 'COPE',   wardVotes: 42,    prVotes: 171,   wardSeats: 0 },
        { party: 'UIM',    wardVotes: 0,     prVotes: 157,   wardSeats: 0 },
        { party: 'ANA',    wardVotes: 68,    prVotes: 71,    wardSeats: 0 },
        { party: 'IRC',    wardVotes: 56,    prVotes: 68,    wardSeats: 0 },
        { party: 'APM',    wardVotes: 30,    prVotes: 51,    wardSeats: 0 },
        { party: 'AICM',   wardVotes: 11,    prVotes: 47,    wardSeats: 0 },
        { party: 'AZAPO',  wardVotes: 9,     prVotes: 0,     wardSeats: 0 },
      ],
    },
    expectedTotalSeats: {
      ANC: 44, EFF: 14, DA: 12, 'FF+': 4, SAVEMAD: 3, ALJAMAAH: 1, AIC: 1,
      FSD: 1, UDM: 1, ACDP: 1, TCM: 0, UCDP: 0, ABC: 0, AMC: 0, IFP: 0,
      DOP: 0, INDPARTY: 0, ATM: 0, APC: 0, COPE: 0, UIM: 0, ANA: 0, IRC: 0,
      APM: 0, AICM: 0, AZAPO: 0,
    },
    expectedPrSeats: {
      ANC: 8, EFF: 13, DA: 8, 'FF+': 4, SAVEMAD: 3, ALJAMAAH: 1, AIC: 1,
      FSD: 1, UDM: 1, ACDP: 1, TCM: 0, UCDP: 0, ABC: 0, AMC: 0, IFP: 0,
      DOP: 0, INDPARTY: 0, ATM: 0, APC: 0, COPE: 0, UIM: 0, ANA: 0, IRC: 0,
      APM: 0, AICM: 0, AZAPO: 0,
    },
  },
];
