import { withTransaction } from '../db.js';
import {
  MunicipalMoneyClient, SERVICE_ITEMS, AUDITED_ACTUAL,
  type MunicipalityRow, type IncExpRow,
} from './municipalMoney.js';
import type { PoolClient } from 'pg';

/* Promotion for the official sources: fetch, record the attempt, write the
 * facts, record the outcome. Every write goes through source_run so the
 * Sources screen can say when each feed last worked and why it stopped. */

export interface RunResult {
  sourceId: string;
  ok: boolean;
  itemsSeen: number;
  itemsKept: number;
  costUsd?: number;
  error?: string;
}

/** Opens a source_run row, runs the body, and closes the row either way.
 *  A fetch that throws still leaves a record - a feed that fails silently is
 *  worse than one that fails loudly, because nobody goes looking. */
export async function recorded<T>(
  sourceId: string,
  body: (client: PoolClient) => Promise<{ result: T; seen: number; kept: number; costUsd?: number }>,
): Promise<{ result?: T; run: RunResult }> {
  const started = await withTransaction(async (c) => {
    const r = await c.query<{ source_run_id: string }>(
      `INSERT INTO source_run (source_id) VALUES ($1) RETURNING source_run_id`, [sourceId]);
    await c.query(`UPDATE source SET last_attempt_at = now() WHERE source_id = $1`, [sourceId]);
    return r.rows[0]!.source_run_id;
  });

  try {
    const out = await withTransaction((c) => body(c));
    await withTransaction(async (c) => {
      await c.query(
        `UPDATE source_run
            SET finished_at = now(), ok = true,
                items_seen = $2, items_kept = $3, cost_usd = $4
          WHERE source_run_id = $1`,
        [started, out.seen, out.kept, out.costUsd ?? null]);
      await c.query(
        `UPDATE source SET last_ok_at = now(), last_error = NULL WHERE source_id = $1`,
        [sourceId]);
    });
    return {
      result: out.result,
      run: { sourceId, ok: true, itemsSeen: out.seen, itemsKept: out.kept, costUsd: out.costUsd },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await withTransaction(async (c) => {
      await c.query(
        `UPDATE source_run SET finished_at = now(), ok = false, error = $2
          WHERE source_run_id = $1`, [started, message]);
      await c.query(`UPDATE source SET last_error = $2 WHERE source_id = $1`, [sourceId, message]);
    });
    return { run: { sourceId, ok: false, itemsSeen: 0, itemsKept: 0, error: message } };
  }
}

/** The municipality dimension. Upsert on the demarcation code, which is the
 *  stable identifier; names change (Randfontein and Westonaria became Rand
 *  West City) and the code is what historic figures hang off. */
export async function promoteMunicipalities(
  client: PoolClient, rows: MunicipalityRow[],
): Promise<number> {
  let written = 0;
  for (const m of rows) {
    const r = await client.query(
      `INSERT INTO municipality
         (demarcation_code, name, category, province_code, province_name, retrieved_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (demarcation_code) DO UPDATE
         SET name          = EXCLUDED.name,
             category      = EXCLUDED.category,
             province_code = EXCLUDED.province_code,
             province_name = EXCLUDED.province_name,
             retrieved_at  = now()`,
      [m.demarcation_code, m.name, m.category, m.province_code, m.province_name]);
    written += r.rowCount ?? 0;
  }
  return written;
}

/** Service-charge revenue, one fact per municipality, year and service.
 *
 *  Only the four lines that answer to a grievance category are kept. The rest
 *  of the statement is fetched - it is one request either way - but storing
 *  every item would fill service_fact with figures nothing in Venom reads. */
export async function promoteServiceRevenue(
  client: PoolClient, rows: IncExpRow[],
): Promise<number> {
  const byCode = new Map(SERVICE_ITEMS.map((s) => [s.code, s]));
  let written = 0;

  for (const row of rows) {
    const service = byCode.get(row.item_code);
    if (!service) continue;

    const r = await client.query(
      `INSERT INTO service_fact
         (source_id, demarcation_code, financial_year, metric, category,
          value, unit, publisher_label, source_url, retrieved_at)
       VALUES ('municipal_money', $1, $2, $3, $4::issue_category, $5, 'ZAR', $6, $7, now())
       ON CONFLICT (source_id, demarcation_code, financial_year, metric) DO UPDATE
         SET value           = EXCLUDED.value,
             publisher_label = EXCLUDED.publisher_label,
             source_url      = EXCLUDED.source_url,
             retrieved_at    = now()`,
      [
        row.demarcation_code,
        row.financial_year,
        `service_charge_revenue.${service.category.toLowerCase()}`,
        service.category,
        row.amount,
        row.item_label || service.treasuryLabel,
        MunicipalMoneyClient.factsUrl('incexp_v2', row.demarcation_code, row.financial_year),
      ]);
    written += r.rowCount ?? 0;
  }
  return written;
}

/** One pass: the municipality list, then the service lines for each
 *  ward-holding municipality across the requested years.
 *
 *  District councils (category C) are skipped - they hold no wards, so a
 *  figure against one cannot be read beside a ward. */
export async function runMunicipalMoney(
  years: number[],
  provinceCode = 'GT',
): Promise<RunResult> {
  const client = new MunicipalMoneyClient();

  const { run } = await recorded('municipal_money', async (c) => {
    const municipalities = await client.municipalities(provinceCode);
    const kept = await promoteMunicipalities(c, municipalities);

    const wardHolding = municipalities.filter((m) => m.category !== 'C');
    let seen = municipalities.length;
    let facts = 0;

    for (const m of wardHolding) {
      for (const year of years) {
        const rows = await client.incomeAndExpenditure(m.demarcation_code, year, AUDITED_ACTUAL);
        seen += rows.length;
        facts += await promoteServiceRevenue(c, rows);
      }
    }

    return { result: { municipalities: kept, facts }, seen, kept: kept + facts };
  });

  return run;
}
