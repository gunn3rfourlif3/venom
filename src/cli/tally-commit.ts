/* Seal a tally snapshot.
 *
 *   npm run tally:commit -- --scope NATIONAL
 *   npm run tally:commit -- --scope PROVINCE --key "Gauteng"
 *   npm run tally:commit -- --scope MUNICIPALITY --key NW372 --note "22:10 cut"
 *
 * Reads the current counts, computes a digest over them plus a fresh random
 * nonce, and appends one link to the chain. The counts and the nonce are
 * stored but the digest is what you publish now; `tally:reveal` opens it.
 *
 * WHY THE COUNTS ARE STORED RATHER THAN DISCARDED. A commitment you cannot
 * open is not a commitment, and recomputing the tally at reveal time would
 * give a different answer - more slips will have arrived. The seal is on the
 * numbers as they stood at that instant, so they have to be kept.
 *
 * The honest consequence: anyone with database access can read a sealed
 * tally before the reveal. This scheme is for proving a number was not
 * changed after the fact; it does NOT keep that number secret from the
 * people running the system, and nothing built in a database you control
 * could. If the counts need to be secret from your own staff too, the seal
 * has to be computed somewhere they cannot reach, which is a different
 * project.
 */

import { pool, withTransaction } from '../db.js';
import {
  GENESIS, digestOf, newNonce, canonicalForm,
  canonicalTime, type PartyCount,
} from '../tally/commit.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const scope = (arg('scope') ?? 'NATIONAL').toUpperCase();
const key = arg('key') ?? '';
const note = arg('note') ?? null;
const showForm = process.argv.includes('--show-form');
/* Marks this as one of the two or three cuts a night whose digest actually
   goes out. It changes only what is printed - every seal is identical in the
   chain, and any of them can be anchored later. */
const anchorNow = process.argv.includes('--anchor-now');

if (!['NATIONAL', 'PROVINCE', 'MUNICIPALITY'].includes(scope)) {
  console.error(`unknown scope ${scope} — use NATIONAL, PROVINCE or MUNICIPALITY`);
  process.exit(2);
}
if (scope !== 'NATIONAL' && !key) {
  console.error(`--scope ${scope} needs --key (a province name or a demarcation code)`);
  process.exit(2);
}
if (scope === 'NATIONAL' && key) {
  console.error('--scope NATIONAL takes no --key');
  process.exit(2);
}

/* Scope is matched on an indexed column rather than interpolated, and the
   parameter is always supplied so the three cases share one query shape. */
const WHERE = scope === 'NATIONAL' ? 'TRUE'
  : scope === 'PROVINCE' ? 'province = $1'
  : 'demarcation_code = $1';
const params = scope === 'NATIONAL' ? [] : [key];

const main = async () => {
  const counts = await pool.query<{ party: string; votes: number }>(
    `SELECT party, SUM(votes)::bigint AS votes
       FROM v_tally_vote
      WHERE ${WHERE}
      GROUP BY party
      ORDER BY party`, params);

  if (counts.rows.length === 0) {
    /* Refusing is right - a digest over an empty tally is a valid digest of
       nothing, and would later read as a snapshot that had been taken. But
       "no counted votes" has four quite different causes and they need
       quite different responses at 21:00. Saying only that nothing was
       counted leaves someone running psql by hand to find out which, which
       is not a thing to be doing on the night. So it diagnoses. */
    const d = await pool.query<{
      slips: number; transcribed: number; disputed: number;
      rejected: number; superseded: number; other: number; in_scope: number;
    }>(
      `SELECT
         count(*)::int                                            AS slips,
         count(*) FILTER (WHERE rs.status IN ('VERIFIED','TRANSCRIBED')
                            AND rs.rejected IS NULL
                            AND rs.superseded IS NOT TRUE)::int    AS transcribed,
         count(*) FILTER (WHERE rs.status = 'DISPUTED')::int       AS disputed,
         count(*) FILTER (WHERE rs.rejected IS NOT NULL)::int      AS rejected,
         count(*) FILTER (WHERE rs.superseded IS TRUE)::int        AS superseded,
         count(*) FILTER (WHERE rs.status IS NULL
                            OR rs.status NOT IN ('VERIFIED','TRANSCRIBED','DISPUTED')
                           )::int                                  AS other,
         count(*) FILTER (WHERE ${WHERE === 'TRUE' ? 'TRUE' : WHERE.replace(/^/, 'w.')})::int AS in_scope
       FROM result_slip rs
       JOIN station st ON st.station_id = rs.station_id
       JOIN ward w     ON w.ward_id = st.ward_id`, params);
    const c = d.rows[0]!;

    const where = `${scope}${key ? ` ${key}` : ''}`;
    const lines = [`Nothing sealed: no counted votes for ${where}.`, ''];

    if (c.slips === 0) {
      lines.push('No result slips have been captured anywhere yet. Nothing is',
        'wrong — this is what the command says until capture starts.');
    } else if (scope !== 'NATIONAL' && c.in_scope === 0) {
      lines.push(`${c.slips.toLocaleString('en-ZA')} slips are captured, but none `
        + `are in ${where}.`,
        'Check the spelling of --key: a province wants its name ("Gauteng"),',
        'a municipality its demarcation code ("NW372").');
    } else if (c.transcribed === 0) {
      lines.push(`${c.slips.toLocaleString('en-ZA')} slips are captured, but none `
        + 'are counted. Reasons:', '');
      if (c.disputed > 0) {
        lines.push(`  ${c.disputed.toLocaleString('en-ZA')} DISPUTED — the two passes `
          + 'disagree. These are',
          '     excluded by design, never averaged or resolved by taking the',
          '     first. They need a human to look at the slip.');
      }
      if (c.rejected > 0) {
        lines.push(`  ${c.rejected.toLocaleString('en-ZA')} rejected.`);
      }
      if (c.superseded > 0) {
        lines.push(`  ${c.superseded.toLocaleString('en-ZA')} superseded by a later capture.`);
      }
      if (c.other > 0) {
        lines.push(`  ${c.other.toLocaleString('en-ZA')} captured but not transcribed yet `
          + '— images are arriving,',
          '     nobody is entering them. This is the usual one early on.');
      }
    } else {
      /* Slips are counted somewhere but produced no party rows here. Means
         transcriptions exist with no result_vote rows behind them, which
         should not happen and is worth saying rather than glossing. */
      lines.push(`${c.transcribed.toLocaleString('en-ZA')} slips are counted but carry `
        + 'no party votes.',
        'That should not be possible — a transcription writes its vote rows in',
        'the same transaction. Worth looking at before trusting any total.');
    }

    console.error(lines.join('\n'));
    process.exit(1);
  }

  const cov = await pool.query<{ counted: number; expected: number; disputed: number }>(
    `SELECT COALESCE(SUM(slips_counted), 0)::bigint   AS counted,
            COALESCE(SUM(slips_expected), 0)::bigint  AS expected,
            COALESCE(SUM(slips_disputed), 0)::bigint  AS disputed
       FROM v_tally_coverage
      WHERE ${WHERE}`, params);
  const coverage = cov.rows[0]!;

  const partyCounts: PartyCount[] = counts.rows.map((r) => ({
    party: r.party, votes: Number(r.votes),
  }));

  const result = await withTransaction(async (client) => {
    /* The chain is global, not per scope: one sequence, so a reader cannot be
       shown a short per-province chain that omits an inconvenient link.
       SERIALIZABLE, because two commits racing on the tail would both read
       the same prev_digest and fork the chain. The primary key on seq would
       reject the second anyway, but failing on a lock is a retry whereas
       failing on a duplicate key looks like corruption. */
    await client.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');

    const tail = await client.query<{ seq: number; digest: string }>(
      'SELECT seq, digest FROM tally_commitment ORDER BY seq DESC LIMIT 1');

    const seq = (tail.rows[0]?.seq ?? 0) + 1;
    const prev = tail.rows[0]?.digest ?? GENESIS;
    const nonce = newNonce();
    const takenAt = canonicalTime(new Date());

    const snap = {
      seq, scope, scopeKey: key, takenAt,
      counts: partyCounts,
      slipsCaptured: Number(coverage.counted),
      slipsExpected: Number(coverage.expected),
    };
    const digest = digestOf(snap, prev, nonce);

    await client.query(
      `INSERT INTO tally_commitment
         (seq, scope, scope_key, taken_at, slips_captured, slips_expected,
          prev_digest, digest, counts, nonce, revealed_at, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,$11)`,
      [seq, scope, key, takenAt, snap.slipsCaptured, snap.slipsExpected,
       prev, digest, JSON.stringify(partyCounts), nonce, note]);

    return { seq, digest, prev, snap, nonce };
  });

  const total = partyCounts.reduce((a, c) => a + c.votes, 0);
  const pct = result.snap.slipsExpected
    ? (100 * result.snap.slipsCaptured / result.snap.slipsExpected).toFixed(1)
    : '—';

  console.log(`\nSealed  seq ${result.seq}  ${scope}${key ? ` ${key}` : ''}`);
  console.log(`  taken      ${result.snap.takenAt}`);
  console.log(`  parties    ${partyCounts.length}`);
  console.log(`  votes      ${total.toLocaleString('en-ZA')}`);
  console.log(`  slips      ${result.snap.slipsCaptured.toLocaleString('en-ZA')}`
    + ` of ${result.snap.slipsExpected.toLocaleString('en-ZA')} (${pct}%)`);
  if (Number(coverage.disputed) > 0) {
    console.log(`  disputed   ${Number(coverage.disputed).toLocaleString('en-ZA')}`
      + ' slips excluded — this tally is incomplete, not merely early');
  }
  /* The anchor prompt is CONDITIONAL, and that is a deliberate correctness
     point rather than a nicety.

     The procedure is to seal hourly and send an anchor two or three times a
     night - at 20:00, 23:00 and declaration - which works because each digest
     contains the previous one, so one anchor freezes every seal before it.
     Printing "PUBLISH THIS LINE NOW" after all eleven seals would be wrong
     eight times, and an instruction that is usually wrong is an instruction
     people learn to scroll past. The one time it matters it would be
     invisible.

     So an ordinary seal says what it is, and names how many seals are riding
     on the next anchor. */
  const unanchored = await pool.query<{ n: number; oldest: number }>(
    `SELECT count(*)::int AS n, COALESCE(min(seq), 0)::int AS oldest
       FROM tally_commitment
      WHERE seq > COALESCE((SELECT max(seq) FROM tally_commitment
                             WHERE anchored_at IS NOT NULL), 0)`);
  const waiting = unanchored.rows[0]?.n ?? 0;
  const oldest = unanchored.rows[0]?.oldest ?? result.seq;

  const line = `Xnith tally commitment ${result.seq} `
    + `${scope}${key ? `/${key}` : ''} ${result.snap.takenAt} `
    + `sha256:${result.digest}`;

  if (anchorNow) {
    console.log(`\n  SEND THIS LINE OUTSIDE THE CAMPAIGN NOW:\n`);
    console.log(`  ${line}`);
    console.log(`\n  It freezes ${waiting === 1 ? 'this seal' : `seals ${oldest}–${result.seq}`}`
      + ' for everyone, including us. Until it is in');
    console.log('  someone else\'s hands the chain proves only that nobody else');
    console.log('  edited it. Record that you sent it:');
    console.log(`    npm run tally:export -- --mark-sent "where you sent it"\n`);
  } else {
    console.log(`\n  Sealed only — no need to send anything.`);
    console.log(`  ${waiting} seal${waiting === 1 ? '' : 's'} `
      + `(${waiting === 1 ? `#${result.seq}` : `#${oldest}–#${result.seq}`}) `
      + 'now ride on the next anchor;');
    console.log('  sending one line then freezes all of them at once.');
    console.log(`  Next anchor due at 23:00 and at declaration. To send now:`);
    console.log('    npm run tally:export\n');
    console.log(`  digest  sha256:${result.digest}\n`);
  }

  if (showForm) {
    console.log('--- exact bytes hashed ---');
    process.stdout.write(canonicalForm(result.snap, result.prev, result.nonce));
    console.log('--- end (pipe to `sha256sum` to check by hand) ---\n');
  }
};

main()
  .catch((error) => { console.error(error.message ?? error); process.exitCode = 1; })
  .finally(() => pool.end());
