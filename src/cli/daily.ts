import { spawn } from 'node:child_process';
import { pool } from '../db.js';

/* The daily sweep. One command for the Scheduled Task to call.
 *
 *   npm run daily
 *
 * WHY CHILD PROCESSES RATHER THAN IMPORTS. Each sweep is a top-level-await
 * script that opens its own pool and calls process.exit when it is done.
 * Importing them here would mean the first one to finish closes the pool
 * under the others and exits the whole run. Spawned, each keeps its own
 * connection and its own exit code, and one source being down for the
 * morning costs only that source.
 *
 * WHY THE ORDER IS WHAT IT IS. The press and news sweeps write signal rows;
 * the extract is computed from them, so it is refreshed after, not before.
 * Retention purge runs last because it is the only destructive step and
 * should not run if the process is already failing.
 */

interface Step {
  name: string;
  script: string;
  args?: string[];
  /** A step that may fail without failing the day. A community paper being
   *  down is weather; the extract refresh failing means the dashboard is
   *  serving yesterday's numbers and somebody should know. */
  optional: boolean;
}

const STEPS: Step[] = [
  { name: 'local press', script: 'dist/cli/sources-press.js', args: ['--days', '2'],
    optional: true },
  { name: 'news',        script: 'dist/cli/sources-news.js',  args: ['--days', '2'],
    optional: true },
  { name: 'alerts',      script: 'dist/cli/alerts-check.js', optional: true },
  { name: 'retention',   script: 'dist/cli/retention-purge.js', optional: false },
];

function run(step: Step): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [step.script, ...(step.args ?? [])], {
      stdio: 'inherit',
      // The parent was started with --env-file, so the variables are already
      // in this process's environment and are inherited.
      env: process.env,
    });
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

const started = Date.now();
const failures: string[] = [];

console.log(`venom daily — ${new Date().toISOString()}`);

for (const step of STEPS) {
  console.log(`\n── ${step.name} ──`);
  const code = await run(step);
  if (code !== 0) {
    failures.push(step.name);
    console.error(`${step.name} exited ${code}${step.optional ? ' (not fatal)' : ''}`);
    if (!step.optional) break;
  }
}

/* The extract is a materialised view of numbers the sweeps just changed.
 * CONCURRENTLY so a dashboard open on someone's desk keeps reading the old
 * rows until the new ones are ready rather than blocking. */
try {
  console.log('\n── extract ──');
  await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_campaign_extract');
  console.log('mv_campaign_extract refreshed');
} catch (error) {
  failures.push('extract refresh');
  console.error(`extract refresh failed — ${(error as Error).message}`);
}

/* What the day produced, so the log the Scheduled Task leaves behind is
 * worth reading. */
try {
  const { rows } = await pool.query(
    `SELECT source, count(*)::int AS rows, sum(mentions)::int AS mentions,
            max(observed_on) AS latest
       FROM issue_signal
      WHERE observed_on >= CURRENT_DATE - 1
      GROUP BY source ORDER BY source`);
  if (rows.length === 0) console.log('\nNo new signal rows today.');
  else { console.log('\nToday:'); console.table(rows); }
} catch { /* reporting only */ }

const seconds = Math.round((Date.now() - started) / 1000);
await pool.end();

if (failures.length > 0) {
  console.error(`\ndaily finished in ${seconds}s with failures: ${failures.join(', ')}`);
  process.exit(1);
}
console.log(`\ndaily finished in ${seconds}s`);
process.exit(0);
