import { runMunicipalMoney } from '../sources/promote.js';
import { pool } from '../db.js';

/* Loads the official, open sources: the municipality dimension and
 * service-charge revenue from National Treasury.
 *
 *   npm run sources:official -- 2023 2024
 *
 * No credential is needed. This is the one source in the registry that can
 * run unattended today; everything else is either keyed, metered, licensed
 * or closed. */

const years = process.argv.slice(2)
  .map(Number)
  .filter((y) => Number.isInteger(y) && y >= 2000 && y <= 2100);

if (years.length === 0) {
  // Treasury publishes audited actuals well after year end, so the default
  // deliberately trails: asking for the current year returns empty cells and
  // looks like a broken client.
  const thisYear = new Date().getUTCFullYear();
  years.push(thisYear - 2, thisYear - 1);
}

console.log(`Municipal Money: financial years ${years.join(', ')}`);

const run = await runMunicipalMoney(years);

if (run.ok) {
  console.log(`ok — ${run.itemsSeen} rows seen, ${run.itemsKept} facts written`);
} else {
  console.error(`failed — ${run.error}`);
}

await pool.end();
process.exit(run.ok ? 0 : 1);
