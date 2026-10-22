/**
 * Result-slip capture.
 *
 * A marshal opens a personal link on a phone, photographs the slip taped to
 * the station door, and it arrives here. There is no sign-in: the token in
 * the link is the credential (see migration 030).
 *
 * The image bytes are written to disk, never to Postgres. A night of
 * photographs is measured in gigabytes and the database container is capped
 * at 3GB; more to the point, a dump that has to carry them is a dump nobody
 * can restore quickly, and the restore is the thing that has to work.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import { pool } from '../db.js';
import { HttpError, json, readJson, type Ctx } from './http.js';
import { requireRole } from './auth.js';

/** Where the photographs live. Outside the repo, on a volume. */
function storeRoot(): string {
  return process.env.SLIP_STORE ?? join(process.cwd(), 'slip-store');
}

/* A phone camera produces 3-8MB. The capture page downscales before sending,
   so anything arriving above this is either a client that failed to resize or
   something that is not a slip photograph. Both are worth refusing: 66,183
   slips at 8MB would be half a terabyte. */
const MAX_BYTES = 2_500_000;

/**
 * What kind of image is this, judged by its first bytes rather than by what
 * the client said it was. A declared content-type is a claim by the uploader;
 * the magic number is the file.
 */
function imageKind(buf: Buffer): 'jpg' | 'png' | null {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 8 && buf.subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  return null;
}

/** Strip an optional data-URL prefix and decode. Returns null on anything
 *  that is not plausible base64, rather than letting Buffer.from quietly
 *  produce rubbish — it ignores invalid characters instead of throwing. */
function decodeImage(raw: unknown): Buffer | null {
  if (typeof raw !== 'string' || raw === '') return null;
  const b64 = raw.replace(/^data:image\/[a-z+]+;base64,/, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  const buf = Buffer.from(b64, 'base64');
  return buf.length === 0 ? null : buf;
}

interface Identity {
  phone: string;
  display_name: string;
  assigned_station: string | null;
}

async function identify(token: unknown): Promise<Identity> {
  if (typeof token !== 'string' || token.length < 32) {
    throw new HttpError(401, 'This link is not valid.');
  }
  const { rows } = await pool.query<Identity>(
    `SELECT phone, display_name, assigned_station
       FROM v_capture_identity WHERE capture_token = $1`, [token]);
  const who = rows[0];
  /* The view already excludes disabled marshals and expired retention, so
     there is one definition of "may upload" rather than a check repeated at
     each call site and eventually repeated wrongly. */
  if (!who) throw new HttpError(401, 'This link is no longer active.');
  return who;
}

/**
 * POST /api/slip — open route, authenticated by the token in the body.
 *
 * The token travels in the body and never in the query string, so it does not
 * reach web server logs, the browser history, or a Referer header on the way
 * to any third party.
 */
export async function postSlip(ctx: Ctx): Promise<void> {
  /* readJson defaults to 64KB, which is fine for every other endpoint here
     and catastrophic for this one: a downscaled phone photograph is 200-400KB
     and base64 adds a third again. The default silently rejected every real
     upload while a 2.5KB synthetic test image passed — so the limit is stated
     explicitly, derived from MAX_BYTES rather than guessed. */
  const body = await readJson<{
    token?: string; stationId?: string; ballot?: string; image?: string;
  }>(ctx.req, Math.ceil(MAX_BYTES * 4 / 3) + 4096);

  const who = await identify(body.token);

  const stationId = typeof body.stationId === 'string' ? body.stationId.trim() : '';
  const ballot = typeof body.ballot === 'string' ? body.ballot.trim() : '';
  if (stationId === '') throw new HttpError(400, 'Which station?');

  /* The station/ballot pair is checked against what SHOULD exist rather than
     against the station table alone. A metro station has no district PR
     ballot, and accepting one would put a slip in the coverage denominator
     that can never be matched. */
  const { rows: expected } = await pool.query(
    `SELECT 1 FROM v_slip_expected WHERE station_id = $1 AND ballot = $2::ballot_type`,
    [stationId, ballot]);
  if (expected.length === 0) {
    throw new HttpError(400,
      `Station ${stationId} does not have a ${ballot || '(none given)'} ballot.`);
  }

  const buf = decodeImage(body.image);
  if (!buf) throw new HttpError(400, 'No photograph received.');
  if (buf.length > MAX_BYTES) {
    throw new HttpError(413,
      `That photograph is ${Math.round(buf.length / 1000)}KB. Try again — `
      + `the page should shrink it before sending.`);
  }
  const kind = imageKind(buf);
  if (!kind) throw new HttpError(400, 'That file is not a photograph.');

  /* The path is derived entirely from the hash and the date. Nothing the
     uploader sent is ever part of a filename, so there is no traversal to
     defend against rather than a defence to get right. */
  const sha = createHash('sha256').update(buf).digest('hex');
  const now = new Date();
  const rel = join(
    String(now.getUTCFullYear()),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0'),
    `${sha}.${kind}`);
  const abs = join(storeRoot(), rel);

  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, buf);

  /* The same bytes for the same station and ballot is a double-submit, not a
     second photograph: a marshal tapping twice, or a retry on a dropped
     connection outside a hall with one bar of signal. Two rows would inflate
     coverage and put the same slip in the transcription queue twice. A
     genuine re-photograph has different bytes and so a different hash, and is
     still kept — this only collapses the identical case. Same reasoning as
     the wamid dedupe on inbound messages (G21). */
  const existing = await pool.query<{ slip_id: string }>(
    `SELECT slip_id FROM result_slip
      WHERE station_id = $1 AND ballot = $2::ballot_type AND image_sha256 = $3
      LIMIT 1`,
    [stationId, ballot, sha]);

  const slipId = existing.rows[0]
    ? Number(existing.rows[0].slip_id)
    : Number((await pool.query<{ slip_id: string }>(
        `INSERT INTO result_slip
           (station_id, ballot, image_path, image_sha256, image_bytes, captured_by)
         VALUES ($1, $2::ballot_type, $3, $4, $5, $6)
         RETURNING slip_id`,
        [stationId, ballot, rel, sha, buf.length, who.phone])).rows[0]!.slip_id);

  json(ctx.res, 201, {
    data: {
      slipId,
      station: stationId,
      ballot,
      received: buf.length,
      duplicate: existing.rows.length > 0,
    },
  });
}

/**
 * GET /api/slip/:id/image — the photograph, for the transcription screen.
 * Operators only: this is the one place marshal-captured imagery is served,
 * and it is not public.
 */
export async function getSlipImage(ctx: Ctx, id: string): Promise<void> {
  /* 'reporter' and above: the people who transcribe. Not viewers — a slip
     photograph can show faces and handwriting, and it is the one piece of
     marshal-captured imagery the system holds. */
  requireRole(ctx, 'reporter');
  const { rows } = await pool.query<{ image_path: string }>(
    'SELECT image_path FROM result_slip WHERE slip_id = $1', [Number(id)]);
  const row = rows[0];
  if (!row) throw new HttpError(404, 'No such slip.');

  /* The stored path came from our own hash, but it is still re-checked
     against the root before being opened: a value that is trusted because of
     where it came from stops being trustworthy the moment anything else can
     write to that column. */
  const abs = normalize(join(storeRoot(), row.image_path));
  if (!abs.startsWith(normalize(storeRoot()))) {
    throw new HttpError(500, 'Bad image path.');
  }

  const buf = await readFile(abs).catch(() => null);
  if (!buf) throw new HttpError(404, 'The photograph is missing from the store.');

  ctx.res.writeHead(200, {
    'content-type': abs.endsWith('.png') ? 'image/png' : 'image/jpeg',
    'content-length': buf.length,
    'cache-control': 'private, max-age=3600',
  });
  ctx.res.end(buf);
}

/**
 * GET /api/slip/station?token=…&q=… — station lookup for the capture page.
 *
 * A marshal types part of a booth number and picks from the matches, rather
 * than keying 8 digits correctly at 23:00 in the dark. Returns which ballots
 * that station should produce, so the page can ask for each one.
 */
export async function getCaptureStations(ctx: Ctx): Promise<void> {
  const token = ctx.url.searchParams.get('token');
  const who = await identify(token);
  const q = (ctx.url.searchParams.get('q') ?? '').trim();

  /* A marshal with an assigned station gets it without searching. */
  const { rows } = await pool.query(
    `SELECT e.station_id,
            s.name,
            e.ward_id,
            e.municipality,
            array_agg(e.ballot::text ORDER BY e.ballot) AS ballots,
            array_remove(array_agg(c.ballot::text ORDER BY c.ballot), NULL) AS done
       FROM v_slip_expected e
       JOIN station s ON s.station_id = e.station_id
       LEFT JOIN v_slip_current c
              ON c.station_id = e.station_id AND c.ballot = e.ballot
      WHERE ($1::text IS NULL OR e.station_id = $1)
        AND ($2 = '' OR e.station_id ILIKE '%' || $2 || '%' OR s.name ILIKE '%' || $2 || '%')
      GROUP BY e.station_id, s.name, e.ward_id, e.municipality
      ORDER BY e.station_id
      LIMIT 25`,
    [who.assigned_station, q]);

  json(ctx.res, 200, { data: { marshal: who.display_name, stations: rows } });
}

export const slips = { postSlip, getSlipImage, getCaptureStations };
