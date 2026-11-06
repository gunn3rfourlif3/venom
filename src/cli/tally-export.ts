/* Emit the chain for publication outside this system.
 *
 *   npm run tally:export                 # the anchor line for the newest link
 *   npm run tally:export -- --format md  # the full table, for a post or email
 *   npm run tally:export -- --format csv
 *
 * THIS IS THE PART THAT MATTERS. Everything else in this module makes
 * tampering detectable from inside the database. That is worth having, and
 * it is not evidence: whoever owns the database can rebuild the chain so
 * that it verifies perfectly against altered numbers.
 *
 * Publishing a digest somewhere you do not control removes that. Once the
 * line below sits in somebody else's inbox, every link up to it is fixed -
 * including for you. A later chain that disagrees with their copy is caught
 * by the discrepancy, and nothing you can do to this database changes what
 * they already hold.
 *
 * So: export after every seal, and send it to someone with no stake in the
 * answer. A party agent from another party is ideal. An observer, a
 * journalist, a WhatsApp group with timestamps - all fine. The recipient
 * does not need to understand any of this. They need to keep the message.
 *
 * It costs nothing to publish and the whole scheme is decoration without it.
 */

import { pool } from '../db.js';
import { canonicalTime } from '../tally/commit.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const format = (arg('format') ?? 'line').toLowerCase();
/* Records that the newest digest was sent, and where. A POINTER, not proof:
   see migration 056. It exists because at 02:00 nobody remembers which of
   eleven lines went to the observers' group, and without that
   `tally:verify --anchor` cannot be run at all. */
const markSent = arg('mark-sent');

interface Row {
  seq: number; scope: string; scope_key: string; taken_at: Date;
  slips_captured: number; slips_expected: number;
  digest: string; prev_digest: string;
  revealed_at: Date | null; parties: number; note: string | null;
  anchored_at: Date | null; anchored_to: string | null;
}

const label = (r: Row) => `${r.scope}${r.scope_key ? `/${r.scope_key}` : ''}`;

const main = async () => {
  /* Read the masked public view, not the table. The export must not be able
     to leak a sealed tally by accident, and the surest way to guarantee that
     is to read from something that does not have the counts to leak. */
  const { rows } = await pool.query<Row>(
    `SELECT seq, scope, scope_key, taken_at, slips_captured, slips_expected,
            digest, prev_digest, revealed_at, parties, note,
            anchored_at, anchored_to
       FROM v_commitment_chain ORDER BY seq`);

  if (rows.length === 0) {
    console.error('The chain is empty — nothing to publish.');
    process.exit(1);
  }

  if (format === 'line') {
    const r = rows[rows.length - 1]!;
    /* The line itself goes to stdout and everything else to stderr, so
       `npm run tally:export > anchor.txt` or a pipe into a message gets the
       line alone. On the night someone will do exactly that. */
    console.log(`Xnith tally commitment ${r.seq} ${label(r)} `
      + `${canonicalTime(r.taken_at)} sha256:${r.digest}`);

    if (markSent) {
      const res = await pool.query(
        `UPDATE tally_commitment
            SET anchored_at = now(), anchored_to = $2
          WHERE seq = $1 AND anchored_at IS NULL`, [r.seq, markSent]);
      console.error('');
      if (res.rowCount === 1) {
        console.error(`  Recorded: link ${r.seq} sent to "${markSent}".`);
        console.error(`  That freezes links 1–${r.seq}, because each digest`);
        console.error('  contains the one before it.');
      } else {
        /* Already recorded. Not an error - someone re-running the command is
           far more likely than a problem - but it must not look like a fresh
           send, or a line nobody actually sent gets treated as anchored. */
        console.error(`  Link ${r.seq} was already recorded as sent. Nothing`);
        console.error('  changed; an anchor record is written once.');
      }
      console.error('');
      console.error('  THE RECORD IS A POINTER, NOT PROOF. The anchor is the');
      console.error('  copy in the recipient\'s hands. Anyone who could rebuild');
      console.error('  the chain could also rewrite this note to match it.');
    } else {
      console.error('');
      console.error('  Send that line to someone outside your campaign.');
      console.error(`  It freezes links 1–${r.seq}. Then record it:`);
      console.error(`    npm run tally:export -- --mark-sent "observers' group"`);
    }
    console.error('');
    console.error('  Verify against it later with:');
    console.error(`    npm run tally:verify -- --anchor ${r.digest}`);
    console.error('');
    return;
  }

  if (format === 'csv') {
    console.log('seq,scope,taken_at,slips_counted,slips_expected,parties,'
      + 'revealed,anchor_sent,digest');
    for (const r of rows) {
      console.log([r.seq, label(r), canonicalTime(r.taken_at),
        r.slips_captured, r.slips_expected, r.parties,
        r.revealed_at ? 'yes' : 'sealed',
        r.anchored_at ? canonicalTime(r.anchored_at) : '', r.digest].join(','));
    }
    return;
  }

  if (format === 'md') {
    console.log('## Xnith tally commitments\n');
    console.log('Each line is a tally snapshot sealed at the time shown. The digest');
    console.log('was published when the snapshot was taken; the counts are published');
    console.log('at declaration. Anyone can then recompute the digest from the counts');
    console.log('and check that the number has not moved in between.\n');
    console.log('| # | Scope | Taken (UTC) | Slips counted | Parties | Status | SHA-256 |');
    console.log('|---|-------|-------------|---------------|---------|--------|---------|');
    for (const r of rows) {
      const cov = r.slips_expected
        ? `${r.slips_captured.toLocaleString('en-ZA')} / ${r.slips_expected.toLocaleString('en-ZA')}`
        : String(r.slips_captured);
      console.log(`| ${r.seq} | ${label(r)} | ${canonicalTime(r.taken_at)} | ${cov} `
        + `| ${r.parties} | ${r.revealed_at ? 'revealed' : 'sealed'} | \`${r.digest}\` |`);
    }
    console.log('\n**How to check one of these.** Take the counts published for a');
    console.log('snapshot, write them in the canonical form described in');
    console.log('`src/tally/commit.ts`, and run `sha256sum`. It must equal the digest');
    console.log('in this table. The digests were published before the counts were,');
    console.log('so a match shows the counts were not chosen afterwards.\n');
    console.log('**What this does not claim.** These are our own figures from our own');
    console.log('captured result slips. They are not official results; the IEC');
    console.log('declares those. Nor is a snapshot a projection — it is the tally as');
    console.log('it stood, at the coverage shown, which is usually well short of');
    console.log('complete.\n');
    return;
  }

  console.error(`unknown --format ${format} — use line, md or csv`);
  process.exit(2);
};

main()
  .catch((error) => { console.error(error.message ?? error); process.exitCode = 1; })
  .finally(() => pool.end());
