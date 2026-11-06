/* Open sealed commitments.
 *
 *   npm run tally:reveal -- --seq 7
 *   npm run tally:reveal -- --all          # every sealed link
 *   npm run tally:reveal -- --seq 7 --dry-run
 *
 * Publishes the counts and the nonce for a link whose digest went out
 * earlier, so anyone can recompute the digest and check it.
 *
 * WHEN TO RUN THIS. After the result it covers is final. Revealing early
 * does no cryptographic harm - the digest is already fixed, and the counts
 * cannot be changed afterwards - but it removes the only reason the numbers
 * were sealed rather than simply published, which was to be able to show
 * later that they had not moved.
 *
 * The reveal is irreversible by trigger: migration 053 permits counts and
 * nonce to go from NULL to set exactly once and refuses every other update.
 * There is no un-reveal, and that is deliberate - a reveal that could be
 * withdrawn would let a party open a favourable snapshot, see how it landed,
 * and close it again.
 */

import { pool, withTransaction } from '../db.js';
import { digestOf, canonicalTime, type PartyCount } from '../tally/commit.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const seqArg = arg('seq');
const all = process.argv.includes('--all');
const dryRun = process.argv.includes('--dry-run');

if (!all && !seqArg) {
  console.error('give --seq <n> or --all');
  process.exit(2);
}

interface Row {
  seq: number; scope: string; scope_key: string; taken_at: Date;
  slips_captured: number; slips_expected: number;
  prev_digest: string; digest: string;
  counts: PartyCount[]; nonce: string; revealed_at: Date | null;
}

const main = async () => {
  const rows = await pool.query<Row>(
    `SELECT seq, scope, scope_key, taken_at, slips_captured, slips_expected,
            prev_digest, digest, counts, nonce, revealed_at
       FROM tally_commitment
      ${all ? '' : 'WHERE seq = $1'}
      ORDER BY seq`, all ? [] : [Number(seqArg)]);

  if (rows.rows.length === 0) {
    console.error(all ? 'the chain is empty' : `no link at seq ${seqArg}`);
    process.exit(1);
  }

  const pending = rows.rows.filter((r) => r.revealed_at === null);
  if (pending.length === 0) {
    console.log('Nothing to reveal — every link asked for is already open.');
    for (const r of rows.rows) {
      console.log(`  seq ${r.seq}  revealed ${canonicalTime(r.revealed_at!)}`);
    }
    return;
  }

  for (const r of pending) {
    /* Recompute before publishing. If the stored counts no longer produce the
       stored digest, something altered them between seal and reveal, and
       publishing them would put a claim out that fails its own check - far
       worse than publishing nothing. Stop, loudly. */
    const recomputed = digestOf({
      seq: r.seq, scope: r.scope, scopeKey: r.scope_key,
      takenAt: canonicalTime(r.taken_at),
      counts: r.counts,
      slipsCaptured: r.slips_captured,
      slipsExpected: r.slips_expected,
    }, r.prev_digest, r.nonce);

    if (recomputed !== r.digest) {
      console.error(
        `\nREFUSING TO REVEAL seq ${r.seq}.\n\n`
        + `  stored digest     ${r.digest}\n`
        + `  recomputes to     ${recomputed}\n\n`
        + 'The sealed contents no longer match the digest that was published.\n'
        + 'Revealing them would publish a claim that anyone can show is false.\n'
        + 'Run `npm run tally:verify` for the full chain before doing anything\n'
        + 'else, and do not delete this link — it is the evidence.\n');
      process.exit(1);
    }

    const total = r.counts.reduce((a, c) => a + c.votes, 0);
    console.log(`\nseq ${r.seq}  ${r.scope}${r.scope_key ? ` ${r.scope_key}` : ''}`
      + `  taken ${canonicalTime(r.taken_at)}`);
    console.log(`  digest   sha256:${r.digest}`);
    console.log(`  nonce    ${r.nonce}`);
    console.log(`  slips    ${r.slips_captured.toLocaleString('en-ZA')} of `
      + `${r.slips_expected.toLocaleString('en-ZA')}`);
    console.log(`  votes    ${total.toLocaleString('en-ZA')} across ${r.counts.length} parties`);
    for (const c of [...r.counts].sort((a, b) => b.votes - a.votes)) {
      const share = total ? (100 * c.votes / total).toFixed(1).padStart(5) : '    —';
      console.log(`    ${share}%  ${String(c.votes).padStart(10)}  ${c.party}`);
    }
    console.log('  digest verified against these counts: OK');
  }

  if (dryRun) {
    console.log(`\n--dry-run: nothing was opened. Drop the flag to publish.\n`);
    return;
  }

  const opened = await withTransaction(async (client) => {
    const done: number[] = [];
    for (const r of pending) {
      /* revealed_at is the ONLY field this touches. counts and nonce were
         written at seal time (055) and are immutable; publishing them is a
         change of visibility, not of content. Writing it this narrowly is
         what lets the trigger refuse everything else - a reveal can never be
         the moment a count quietly changes. */
      const res = await client.query(
        `UPDATE tally_commitment
            SET revealed_at = now()
          WHERE seq = $1 AND revealed_at IS NULL`, [r.seq]);
      if (res.rowCount === 1) done.push(r.seq);
    }
    return done;
  });

  console.log(`\nOpened ${opened.length} link${opened.length === 1 ? '' : 's'}: `
    + `seq ${opened.join(', ')}`);
  console.log('Anyone holding the published digest can now recompute it from');
  console.log('the counts above. `npm run tally:verify` does it for them.\n');
};

main()
  .catch((error) => { console.error(error.message ?? error); process.exitCode = 1; })
  .finally(() => pool.end());
