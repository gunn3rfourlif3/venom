/* Recompute the whole chain and report every break.
 *
 *   npm run tally:verify
 *   npm run tally:verify -- --anchor <digest>   # check against a published line
 *
 * Exits non-zero on any problem. This is the command that actually checks
 * the digests; `v_commitment_chain.links_to_previous` only checks that each
 * link names its predecessor, because there is no sha256 in this database.
 *
 * WHAT A PASS MEANS, PRECISELY. Every revealed link's digest reproduces from
 * its own stored contents, and every link names its predecessor's digest. So
 * nothing has been edited since it was sealed - by the application, by a
 * stray migration, or by anyone with ordinary write access.
 *
 * WHAT A PASS DOES NOT MEAN. It does not prove the chain was not rebuilt
 * wholesale. Someone who can drop the triggers can also recompute every
 * digest from altered counts, and the result would verify perfectly. A chain
 * is self-consistent evidence, which is worth something against accident and
 * against outsiders, and worth nothing against its own owner.
 *
 * --anchor is the answer to that. Give it a digest you published earlier -
 * from an email, a post, a screenshot, anyone's copy - and it checks that
 * the chain still contains that exact digest at that position. A rebuilt
 * chain fails, because the rebuilt digest will not be the one that was sent
 * out. ONE anchored digest freezes every link up to it. That is the whole
 * security of this scheme; the rest is bookkeeping.
 */

import { pool } from '../db.js';
import { verifyChain, canonicalTime, type ChainLink } from '../tally/commit.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const anchor = arg('anchor')?.replace(/^sha256:/, '').trim().toLowerCase();

const main = async () => {
  const { rows } = await pool.query<ChainLink & { revealed_at: Date | null }>(
    `SELECT seq, scope, scope_key, taken_at, slips_captured, slips_expected,
            prev_digest, digest, counts, nonce, revealed_at
       FROM tally_commitment ORDER BY seq`);

  if (rows.length === 0) {
    console.log('The chain is empty. Nothing to verify.');
    console.log('Seal a snapshot with `npm run tally:commit -- --scope NATIONAL`.');
    return;
  }

  console.log(`\nCommitment chain — ${rows.length} link${rows.length === 1 ? '' : 's'}\n`);

  const problems = verifyChain(rows);
  const bySeq = new Map<number, string[]>();
  for (const p of problems) {
    if (!bySeq.has(p.seq)) bySeq.set(p.seq, []);
    bySeq.get(p.seq)!.push(`${p.kind}: ${p.detail}`);
  }

  for (const r of rows) {
    const bad = bySeq.get(r.seq);
    const mark = bad ? 'BROKEN' : 'ok    ';
    const state = r.revealed_at ? 'revealed' : 'sealed  ';
    const where = `${r.scope}${r.scope_key ? `/${r.scope_key}` : ''}`;
    console.log(`  ${mark}  seq ${String(r.seq).padStart(3)}  ${state}  `
      + `${canonicalTime(r.taken_at)}  ${where.padEnd(22)} `
      + `${r.digest.slice(0, 16)}…`);
    for (const line of bad ?? []) console.log(`           ${line}`);
  }

  /* Sealed links are reported as unverifiable rather than as passing. They
     cannot be recomputed without a nonce, which is the point of sealing, so
     counting them as OK would overstate what this run checked. */
  const sealed = rows.filter((r) => !r.revealed_at).length;
  const revealed = rows.length - sealed;

  console.log(`\n  ${revealed} revealed link${revealed === 1 ? '' : 's'} recomputed`);
  if (sealed > 0) {
    console.log(`  ${sealed} sealed link${sealed === 1 ? '' : 's'} checked for linkage `
      + 'only — a sealed digest cannot be recomputed until it is revealed');
  }

  let failed = problems.length > 0;
  let anchorFailed = false;

  if (anchor) {
    console.log('');
    if (!/^[0-9a-f]{64}$/.test(anchor)) {
      console.log(`  ANCHOR MALFORMED — expected 64 hex characters, got ${anchor.length}`);
      failed = true; anchorFailed = true;
    } else {
      const at = rows.find((r) => r.digest === anchor);
      if (at) {
        console.log(`  ANCHOR MATCHED at seq ${at.seq} (${canonicalTime(at.taken_at)}).`);
        console.log(`  Links 1–${at.seq} are frozen against the copy you published.`);
        if (bySeq.size > 0 && [...bySeq.keys()].some((s) => s <= at.seq)) {
          console.log('  But a link at or before it is BROKEN — see above.');
        }
      } else {
        console.log('  ANCHOR NOT FOUND IN THIS CHAIN.');
        console.log(`    looking for  sha256:${anchor}`);
        console.log('  A digest that was published and is now absent means the');
        console.log('  chain was rebuilt, not merely edited. Keep the published');
        console.log('  copy — it is the evidence, and this database is not.');
        failed = true; anchorFailed = true;
      }
    }
  } else {
    console.log('\n  No --anchor given, so this run checked the chain against itself.');
    console.log('  That catches accidents and outside tampering. It cannot catch a');
    console.log('  chain rebuilt by whoever owns this database — for that, pass a');
    console.log('  digest you published elsewhere: --anchor sha256:…');
  }

  if (failed) {
    /* The anchor is reported separately from the recomputation problems. A
       rebuilt chain has zero internal problems by construction - that is what
       makes it dangerous - so printing "FAILED, 0 problems" would read as a
       glitch rather than as the most serious finding this tool can make. */
    const parts: string[] = [];
    if (problems.length > 0) {
      parts.push(`${problems.length} broken link${problems.length === 1 ? '' : 's'}`);
    }
    if (anchorFailed) parts.push('the published anchor does not match');
    console.log(`\n  RESULT: FAILED — ${parts.join('; ')}.`);
    if (anchorFailed && problems.length === 0) {
      console.log('  The chain is internally consistent, which here means only that');
      console.log('  whoever changed it recomputed the digests too. Trust the copy');
      console.log('  you published, not this database.');
    }
    console.log('');
    process.exitCode = 1;
  } else if (revealed === 0) {
    /* Say what was checked, not what sounds reassuring. With every link still
       sealed, no digest was recomputed - only the linkage was. Reporting a
       clean pass here would be the same false-pass that let verify-data.ts
       claim success for weeks while testing nothing. */
    console.log('\n  RESULT: linkage is intact. NO DIGEST WAS RECOMPUTED — every');
    console.log('  link is still sealed, so this run could not check that any');
    console.log('  digest matches its own counts. It checked only that the links');
    console.log('  join up. Reveal a link to verify it properly.\n');
  } else {
    console.log(`\n  RESULT: ${revealed} digest${revealed === 1 ? '' : 's'} `
      + `reproduce${revealed === 1 ? 's' : ''} from stored counts; all `
      + `${rows.length} links join up.`);
    if (sealed > 0) {
      console.log(`  ${sealed} sealed link${sealed === 1 ? '' : 's'} not checked `
        + 'that way — a sealed digest cannot be recomputed yet.');
    }
    console.log('');
  }
};

main()
  .catch((error) => { console.error(error.message ?? error); process.exitCode = 1; })
  .finally(() => pool.end());
