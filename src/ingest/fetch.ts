import { createHash } from 'node:crypto';
import { pool } from '../db.js';
import type { SourceName } from './sources.js';

/** Stable stringify: key order must not change the hash, or every fetch
 *  looks like a change and promotion never settles. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

export function contentHash(payload: unknown): string {
  return createHash('sha256').update(canonical(payload)).digest('hex');
}

export interface RecordedFetch {
  fetchId: number;
  changed: boolean;
}

/**
 * Write one fetch to staging. Nothing here touches a canonical table.
 *
 * A payload identical to the last one for this (source, key) is still
 * recorded — the fetch happened, and v_ingest_health reads those timestamps
 * to decide staleness — but it is marked promoted immediately so promotion
 * skips it. That is what makes fetching idempotent and safe to over-schedule.
 */
export async function recordFetch(
  source: SourceName,
  sourceKey: string | null,
  sourceUrl: string,
  payload: unknown,
): Promise<RecordedFetch> {
  const hash = contentHash(payload);

  const previous = await pool.query<{ content_hash: string }>(
    `SELECT content_hash FROM raw.fetch
      WHERE source = $1 AND source_key IS NOT DISTINCT FROM $2
      ORDER BY fetched_at DESC LIMIT 1`,
    [source, sourceKey],
  );

  const changed = previous.rows[0]?.content_hash !== hash;

  const inserted = await pool.query<{ fetch_id: number }>(
    `INSERT INTO raw.fetch (source, source_key, source_url, payload, content_hash, promoted_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, CASE WHEN $6 THEN NULL ELSE now() END)
     RETURNING fetch_id`,
    [source, sourceKey, sourceUrl, JSON.stringify(payload), hash, changed],
  );

  const row = inserted.rows[0];
  if (!row) throw new Error('raw.fetch insert returned no row');
  return { fetchId: row.fetch_id, changed };
}

/** The newest payload per key for a source, whether or not it was promoted. */
export async function latestPayloads<T>(source: SourceName): Promise<
  Array<{ sourceKey: string | null; payload: T; fetchedAt: Date; sourceUrl: string | null }>
> {
  const result = await pool.query(
    `SELECT DISTINCT ON (source_key)
            source_key, payload, fetched_at, source_url
       FROM raw.fetch
      WHERE source = $1
      ORDER BY source_key, fetched_at DESC`,
    [source],
  );
  return result.rows.map((r) => ({
    sourceKey: r.source_key,
    payload: r.payload as T,
    fetchedAt: r.fetched_at,
    sourceUrl: r.source_url,
  }));
}

export async function markPromoted(source: SourceName): Promise<number> {
  const result = await pool.query(
    `UPDATE raw.fetch SET promoted_at = now(), promote_error = NULL
      WHERE source = $1 AND promoted_at IS NULL`,
    [source],
  );
  return result.rowCount ?? 0;
}

export async function markPromoteError(source: SourceName, message: string): Promise<void> {
  await pool.query(
    `UPDATE raw.fetch SET promote_error = $2
      WHERE source = $1 AND promoted_at IS NULL`,
    [source, message.slice(0, 2000)],
  );
}
