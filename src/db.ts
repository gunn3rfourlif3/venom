import pg from 'pg';
import { config } from './config.js';

// Postgres returns numeric as string to avoid precision loss. Every numeric
// this codebase reads is a vote count or a percentage well inside the safe
// integer range, so parse them rather than threading strings through.
pg.types.setTypeParser(1700, (v: string) => (v === null ? null : Number(v)));
pg.types.setTypeParser(20, (v: string) => (v === null ? null : Number(v)));

export const pool = new pg.Pool({ connectionString: config.db.connectionString });

pool.on('error', (error) => {
  // A pool client can fail while idle (database restarted, network cut).
  // Without a handler the process exits on an unhandled 'error' event.
  console.error('postgres pool error:', error.message);
});

export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
