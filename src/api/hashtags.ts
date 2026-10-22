/**
 * The hashtag watchlist.
 *
 * What this screen is for: deciding WHICH hashtags are worth one of the
 * thirty slots Instagram allows per rolling seven days, and seeing how many
 * are left before spending one. The quota lives in the platform, not in this
 * application, so it cannot be raised by wanting more — it can only be spent
 * well or badly.
 *
 * What it is NOT: a live search box. Querying a hashtag requires a Meta
 * access token this project does not yet hold, so until one exists the list
 * is a plan rather than a feed. The screen says so rather than presenting an
 * empty table as though nothing were being said.
 *
 * A tag with no municipality is recorded and never ingested, because
 * Instagram hashtag media carries no reliable location and a tag that does
 * not name a place cannot be attributed to one (migration 022). That is easy
 * to do by accident — the tag looks configured and simply never produces
 * anything — so it is counted and shown.
 */

import { pool } from '../db.js';
import { HttpError, json, readJson, type Ctx } from './http.js';
import { requireRole } from './auth.js';

/** Instagram's own rule, repeated here only to size the response. */
const CAP = 30;

export async function getHashtags(ctx: Ctx): Promise<void> {
  requireRole(ctx, 'viewer');
  const [quota, tags, cats] = await Promise.all([
    pool.query('SELECT * FROM v_hashtag_quota'),
    pool.query(
      `SELECT tag, demarcation_code, municipality, category, enabled, resolved,
              last_queried_at, last_media_count, note, in_window, slot_frees_at
         FROM v_hashtag_window
        ORDER BY enabled DESC, in_window DESC, tag`),
    pool.query(`SELECT unnest(enum_range(NULL::issue_category))::text AS category`),
  ]);
  json(ctx.res, 200, {
    as_of: new Date().toISOString(),
    data: { quota: quota.rows[0] ?? null, tags: tags.rows, categories: cats.rows.map((r) => r.category) },
  });
}

/* "#JoburgWater" and "joburgwater " are the same tag. Instagram's own rule is
   letters, digits and underscore, which the table's CHECK already enforces -
   normalising here means a paste with hashes and spaces in it does not come
   back as a wall of constraint violations. */
function cleanTag(raw: string): string | null {
  const t = raw.trim().replace(/^#+/, '').trim();
  return /^[A-Za-z0-9_]{1,100}$/.test(t) ? t : null;
}

/**
 * POST /api/hashtags — add tags from a pasted list.
 *
 * Same shape as the marshal roster: paste a block, get back what was taken
 * and what was refused with a reason. One tag per line, optionally
 * `tag, municipality, category`.
 */
export async function postHashtags(ctx: Ctx): Promise<void> {
  requireRole(ctx, 'admin');
  const body = await readJson<{ text?: string }>(ctx.req);
  if (typeof body.text !== 'string') throw new HttpError(400, 'text required');

  const added: string[] = [];
  const updated: string[] = [];
  const refused: Array<{ line: string; reason: string }> = [];

  for (const line of body.text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;

    const parts = trimmed.split(/[,;\t]/).map((p) => p.trim()).filter(Boolean);
    const tag = cleanTag(parts[0] ?? '');
    if (!tag) {
      refused.push({ line: trimmed, reason: 'not a usable hashtag (letters, digits and _ only)' });
      continue;
    }

    /* Municipality is matched by name, loosely, because nobody types a
       demarcation code. An unmatched name is refused rather than silently
       stored as "no place" — a tag with no municipality is never ingested,
       so accepting a typo here would create a tag that looks configured and
       quietly does nothing. */
    let code: string | null = null;
    if (parts[1]) {
      const m = await pool.query<{ demarcation_code: string }>(
        `SELECT demarcation_code FROM municipality
          WHERE lower(replace(name, ' ', '')) = lower(replace($1, ' ', '')) LIMIT 1`,
        [parts[1]]);
      if (!m.rows[0]) {
        refused.push({ line: trimmed, reason: `no municipality called "${parts[1]}"` });
        continue;
      }
      code = m.rows[0].demarcation_code;
    }

    const category = parts[2] ?? null;
    try {
      const r = await pool.query<{ inserted: boolean }>(
        `INSERT INTO instagram_hashtag (tag, demarcation_code, category, enabled)
         VALUES ($1, $2, $3::issue_category, false)
         ON CONFLICT (tag) DO UPDATE
           SET demarcation_code = COALESCE(EXCLUDED.demarcation_code,
                                           instagram_hashtag.demarcation_code),
               category         = COALESCE(EXCLUDED.category,
                                           instagram_hashtag.category)
         RETURNING (xmax = 0) AS inserted`,
        [tag, code, category]);
      if (r.rows[0]?.inserted) added.push(tag); else updated.push(tag);
    } catch (error) {
      refused.push({ line: trimmed, reason: (error as Error).message.slice(0, 120) });
    }
  }

  /* Added disabled on purpose. Enabling is the act that commits a slot on the
     next run, so it is a separate, deliberate click rather than a side effect
     of pasting a list. */
  json(ctx.res, 201, { data: { added: added.length, updated: updated.length, refused } });
}

/** PATCH /api/hashtags/:tag — enable or disable one tag. */
export async function patchHashtag(ctx: Ctx, tag: string): Promise<void> {
  requireRole(ctx, 'admin');
  const body = await readJson<{ enabled?: boolean }>(ctx.req);
  if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'enabled must be true or false');

  const clean = cleanTag(tag);
  if (!clean) throw new HttpError(400, 'not a usable hashtag');

  if (body.enabled) {
    /* Enabling more tags than the cap is allowed - the adapter will simply
       not get to them all in one run - but it is worth saying, because the
       surplus is invisible otherwise and looks like missing data later. */
    const { rows } = await pool.query<{ enabled: string }>(
      'SELECT count(*) AS enabled FROM instagram_hashtag WHERE enabled');
    if (Number(rows[0]?.enabled ?? 0) >= CAP) {
      const r = await pool.query(
        'UPDATE instagram_hashtag SET enabled = true WHERE tag = $1 RETURNING tag', [clean]);
      if (r.rowCount === 0) throw new HttpError(404, 'no such hashtag');
      json(ctx.res, 200, { data: { tag: clean, enabled: true,
        warning: `${Number(rows[0]!.enabled) + 1} tags are enabled against a cap of ${CAP}. `
               + 'A single run cannot query them all.' } });
      return;
    }
  }

  const r = await pool.query(
    'UPDATE instagram_hashtag SET enabled = $2 WHERE tag = $1 RETURNING tag', [clean, body.enabled]);
  if (r.rowCount === 0) throw new HttpError(404, 'no such hashtag');
  json(ctx.res, 200, { data: { tag: clean, enabled: body.enabled } });
}

export const hashtags = { getHashtags, postHashtags, patchHashtag };
