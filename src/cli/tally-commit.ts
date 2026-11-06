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
    console.error(
      `No counted votes for ${scope}${key ? ` ${key}` : ''}.\n`
      + 'Nothing is sealed. A commitment over an empty tally would be a\n'
      + 'valid digest of nothing, which is worse than no digest at all -\n'
      + 'it would later look like a snapshot that had been taken.');
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
  console.log(`\n  PUBLISH THIS LINE:\n`);
  console.log(`  Xnith tally commitment ${result.seq} `
    + `${scope}${key ? `/${key}` : ''} ${result.snap.takenAt} `
    + `sha256:${result.digest}`);
  console.log(`\n  Until that digest exists somewhere you do not control, the`);
  console.log(`  chain proves only that nobody else edited it. Send it to an`);
  console.log(`  observer, a journalist, or a party agent now — see`);
  console.log(`  \`npm run tally:export\`.\n`);

  if (showForm) {
    console.log('--- exact bytes hashed ---');
    process.stdout.write(canonicalForm(result.snap, result.prev, result.nonce));
    console.log('--- end (pipe to `sha256sum` to check by hand) ---\n');
  }
};

main()
  .catch((error) => { console.error(error.message ?? error); process.exitCode = 1; })
  .finally(() => pool.end());
