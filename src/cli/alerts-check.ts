import { pool } from '../db.js';
import { evaluate, markDelivered, recipients, type Alert } from '../alerts/engine.js';
import { sendText } from '../sources/whatsappSend.js';

/* One pass of the alert engine.
 *
 *   npm run alerts:check
 *   npm run alerts:check -- --dry-run
 *
 * Meant to run on a short timer - every two or three minutes on election
 * day. It is safe to run as often as you like: the dedupe key means a
 * condition that is still true raises nothing new until the window turns
 * over, so running it every minute costs a query and sends nothing.
 *
 * DELIVERY. Alerts always reach the database and the live board. WhatsApp
 * delivery happens when the Graph credentials are configured and there are
 * recipients - and carries a caveat worth stating plainly: outside the
 * 24-hour service window, Meta requires an approved template, so a
 * recipient who has not messaged the number that day may not receive it.
 * The practical answer on the day is for the command centre to message the
 * reporting number once each morning, which opens their window. That is a
 * procedure, not a fix, and it is in the runbook for exactly that reason.
 */

const dryRun = process.argv.includes('--dry-run');

const client = await pool.connect();
let raised: Alert[] = [];
try {
  raised = await evaluate(client);
} catch (error) {
  console.error(`alerts: evaluation failed — ${(error as Error).message}`);
  client.release();
  await pool.end();
  process.exit(1);
}

if (raised.length === 0) {
  console.log('alerts: nothing new');
  client.release();
  await pool.end();
  process.exit(0);
}

console.log(`alerts: ${raised.length} new`);
for (const a of raised) {
  console.log(`  [${a.severity}] ${a.kind} — ${a.body}`);
}

if (dryRun) {
  console.log('\n--dry-run: raised in the database, not delivered.');
  client.release();
  await pool.end();
  process.exit(0);
}

/* Delivery. Grouped by severity so that someone who asked only for serious
   alerts is not sent the rest - the list of people worth interrupting stays
   short only if being on it stays tolerable. */
for (const severity of ['serious', 'warn'] as const) {
  const forThis = raised.filter((a) => a.severity === severity);
  if (forThis.length === 0) continue;

  const to = await recipients(client, severity);
  if (to.length === 0) {
    console.log(`  no recipients for ${severity}; raised only`);
    continue;
  }

  // One message carrying everything in this pass, not one per alert. Four
  // conditions firing together should buzz a phone once.
  const lines = forThis.map((a) => `• ${a.body}`).join('\n');
  const text = `XNITH — ${forThis.length} ${severity === 'serious' ? 'serious ' : ''}`
    + `alert${forThis.length === 1 ? '' : 's'}\n\n${lines}`;

  const ids = forThis.map((a) => a.alert_id);
  const failures: string[] = [];
  let sent = 0;

  for (const person of to) {
    const result = await sendText(person.phone, text);
    if (result.ok) sent += 1;
    else failures.push(`${person.display_name}: ${result.error}`);
  }

  if (sent > 0) {
    await markDelivered(client, ids);
    console.log(`  ${severity}: sent to ${sent}/${to.length}`);
  }
  if (failures.length > 0) {
    // Recorded against the alert, because "we raised it and nobody got it"
    // is the state that must not be invisible.
    await markDelivered(client, ids, failures.join('; ').slice(0, 500));
    for (const f of failures) console.error(`  delivery failed — ${f}`);
  }
}

client.release();
await pool.end();
process.exit(0);
