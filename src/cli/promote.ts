/**
 * Promote staged payloads into the canonical tables, then refresh the
 * extract and notify listeners.
 *
 *   npm run build && npm run promote
 *
 * Campaign-entered columns are never written here: zone, candidate_status,
 * the m1-m5 capacity fields, and everything reported at a station. A promote
 * that overwrote those would erase what the organisers reported.
 */
import { pool } from '../db.js';
import { promoteWards, promoteStations, refreshExtract } from '../ingest/promote.js';
import { markPromoteError } from '../ingest/fetch.js';
import { Source } from '../ingest/sources.js';

const log = (...args: unknown[]) => console.log(new Date().toISOString(), ...args);

async function main(): Promise<void> {
  try {
    const { wards } = await promoteWards();
    log(`wards promoted: ${wards}`);
  } catch (error) {
    await markPromoteError(Source.Wards, (error as Error).message);
    throw error;
  }

  try {
    const { stations } = await promoteStations();
    log(`stations promoted: ${stations}`);
  } catch (error) {
    await markPromoteError(Source.VotingStation, (error as Error).message);
    throw error;
  }

  await refreshExtract();
  log('extract refreshed, NOTIFY extract_stale sent');

  const health = await pool.query(
    `SELECT source, last_fetch_at, last_promote_at, errors_total, pending
       FROM v_ingest_health ORDER BY source`,
  );
  console.table(health.rows);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
