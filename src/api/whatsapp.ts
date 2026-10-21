import { createHmac, timingSafeEqual } from 'node:crypto';
import { pool } from '../db.js';
import { HttpError, json, readJson, readRaw, type Ctx } from './http.js';
import { requireRole } from './auth.js';
import { parseLine, inferSeverity } from './logistics.js';
import { sendText } from '../sources/whatsappSend.js';

/* Automated ingest of marshal reports over the WhatsApp Business Platform.
 *
 * This replaces the HQ paste form as the primary path. The paste form stays,
 * deliberately, as the fallback: when a webhook stops being delivered at
 * 09:00 on election day, a human must still be able to get reports in. An
 * automated pipeline with no manual path is a single point of failure wearing
 * a nicer interface.
 *
 * THE SAME PARSER. Nothing here re-implements the template. parseLine() is
 * the one that the paste form uses and that the drills test, so the webhook
 * and the human path cannot drift apart - a bug found in a drill is fixed in
 * both at once.
 *
 * WHAT THIS DOES NOT DO. It does not send marketing templates, does not
 * initiate conversations, and does not need a green tick. It receives, and it
 * replies inside the 24-hour service window to say what was filed. That is
 * the lightest possible use of the platform and the quickest to stand up.
 */

const APP_SECRET   = process.env.WHATSAPP_APP_SECRET ?? '';
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN ?? '';

/** South African numbers arrive from Meta without a plus and may be typed by
 *  a marshal in any of three local habits. Normalised to E.164 so the roster
 *  is one row per person. */
export function toE164(raw: string, defaultCountry = '27'): string | null {
  const digits = raw.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) {
    return /^\+[1-9]\d{7,14}$/.test(digits) ? digits : null;
  }
  let national = digits;
  if (national.startsWith('00')) national = national.slice(2);
  else if (national.startsWith('0')) national = defaultCountry + national.slice(1);
  else if (!national.startsWith(defaultCountry)) national = defaultCountry + national;
  const e164 = `+${national}`;
  return /^\+[1-9]\d{7,14}$/.test(e164) ? e164 : null;
}

/** Meta signs the raw body with the app secret as X-Hub-Signature-256.
 *
 *  Without this check the endpoint is an open write surface on the public
 *  internet: anyone who finds the URL can file reports. The roster allowlist
 *  is the second lock, not a substitute for this one. */
export function signatureValid(raw: Buffer, header: string | undefined): boolean {
  if (!APP_SECRET || !header) return false;
  const expected = 'sha256=' + createHmac('sha256', APP_SECRET).update(raw).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  // Length check first: timingSafeEqual throws on a length mismatch.
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------------------------------------------------------------- verify

/** Meta's subscription handshake. GET with hub.* params, echo the challenge. */
export async function getWebhook(ctx: Ctx): Promise<void> {
  const mode = ctx.url.searchParams.get('hub.mode');
  const token = ctx.url.searchParams.get('hub.verify_token');
  const challenge = ctx.url.searchParams.get('hub.challenge');

  if (mode === 'subscribe' && VERIFY_TOKEN && token === VERIFY_TOKEN && challenge) {
    ctx.res.writeHead(200, { 'content-type': 'text/plain' });
    ctx.res.end(challenge);
    return;
  }
  throw new HttpError(403, 'Verification failed');
}

// ---------------------------------------------------------------- receive

interface InboundText {
  wamid: string;
  from: string;
  timestamp: string;
  body: string;
}

/** Pull the text messages out of Meta's envelope.
 *
 *  The shape is nested and every level is optional, because one delivery can
 *  carry several entries, each with several changes, each with several
 *  messages - and also status callbacks and echoes of what staff typed in the
 *  app, which are not reports and must not be treated as any. */
export function extractTexts(payload: unknown): InboundText[] {
  const out: InboundText[] = [];
  const body = payload as {
    entry?: Array<{
      changes?: Array<{
        field?: string;
        value?: {
          messages?: Array<{
            id?: string; from?: string; timestamp?: string;
            type?: string; text?: { body?: string };
          }>;
        };
      }>;
    }>;
  };

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      // 'messages' only. In coexistence mode Meta also sends
      // 'smb_message_echoes' for anything staff typed on the phone itself;
      // those are our own outbound text and filing them would invent reports.
      if (change.field && change.field !== 'messages') continue;
      for (const m of change.value?.messages ?? []) {
        if (m.type !== 'text' || !m.id || !m.from || !m.text?.body) continue;
        out.push({
          wamid: m.id,
          from: m.from,
          timestamp: m.timestamp ?? '',
          body: m.text.body,
        });
      }
    }
  }
  return out;
}

type Outcome = 'filed' | 'unknown_sender' | 'unparsed' | 'unknown_booth'
  | 'duplicate_report' | 'ignored';

interface Handled {
  wamid: string;
  outcome: Outcome;
  detail: string | null;
  stationId: string | null;
}

/** One message, in its own transaction.
 *
 *  Per-message rather than per-delivery because a delivery can hold several
 *  reports and one bad one must not reject the others - and because Meta
 *  retries the whole delivery on a non-200, which would re-process the good
 *  ones. Dedupe on the message id is what makes that retry safe. */
async function handleOne(msg: InboundText): Promise<Handled> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const phone = toE164(msg.from);
    const sentAt = /^\d+$/.test(msg.timestamp)
      ? new Date(Number(msg.timestamp) * 1000).toISOString() : null;

    const record = async (
      outcome: Outcome, parseError: string | null, reportId: number | null,
    ): Promise<Handled> => {
      // The dedupe, and it must ROLL BACK rather than commit on a conflict.
      //
      // This is called last, after the booth_report insert, and both are in
      // the same transaction. A redelivered message therefore inserts a
      // second report and only then hits this primary key - so committing
      // here would leave the duplicate report behind with no audit row
      // pointing at it. Rolling back undoes the report too, which is what
      // makes Meta's at-least-once delivery safe.
      const { rowCount } = await client.query(
        `INSERT INTO inbound_message
           (wamid, sent_at, from_phone, body, outcome, parse_error, booth_report_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (wamid) DO NOTHING`,
        [msg.wamid, sentAt, phone ?? msg.from, msg.body, outcome, parseError, reportId]);

      if (rowCount === 0) {
        await client.query('ROLLBACK');
        return {
          wamid: msg.wamid, outcome: 'ignored',
          detail: 'already processed', stationId: null,
        };
      }

      await client.query('COMMIT');
      return { wamid: msg.wamid, outcome, detail: parseError, stationId: null };
    };

    // 1 — is this one of ours?
    if (!phone) return await record('unknown_sender', 'unreadable sender', null);
    const roster = await client.query<{ display_name: string }>(
      'SELECT display_name FROM reporter_roster WHERE phone = $1 AND enabled', [phone]);
    const marshal = roster.rows[0];
    if (!marshal) {
      return await record('unknown_sender', 'sender not on the roster', null);
    }

    // 2 — does it parse?
    const parsed = parseLine(msg.body, 1);
    if (parsed.error || !parsed.stationId) {
      return await record('unparsed', parsed.error ?? 'no booth number', null);
    }

    // 3 — is the booth real? Checked here rather than left to the foreign
    //     key, so the marshal gets told which booth number was wrong.
    const station = await client.query(
      'SELECT 1 FROM station WHERE station_id = $1', [parsed.stationId]);
    if (station.rowCount === 0) {
      return await record('unknown_booth',
        `booth ${parsed.stationId} is not in the register`, null);
    }

    // 4 — file it
    const severity = parsed.problem ? inferSeverity(parsed.problem) : null;
    const { rows } = await client.query<{ booth_report_id: number }>(
      `INSERT INTO booth_report
         (station_id, reported_by, reporter_phone, queue,
          problem, problem_severity, people_on_site)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING booth_report_id`,
      [parsed.stationId, marshal.display_name, phone, parsed.queue,
        parsed.problem, severity, parsed.peopleOnSite]);

    await client.query(
      'UPDATE reporter_roster SET last_message_at = now() WHERE phone = $1', [phone]);

    const handled = await record('filed', null, rows[0]?.booth_report_id ?? null);
    return { ...handled, stationId: parsed.stationId };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Tell the marshal what happened to their message.
 *
 *  Inside the 24-hour service window this needs no approved template, which
 *  is why ingest can be stood up without waiting on template review. It also
 *  does real work: a marshal who gets no acknowledgement does not know
 *  whether to resend, and a marshal who resends doubles the volume.
 *
 *  The Graph call itself lives in sources/whatsappSend.ts, shared with the
 *  alert engine - one place for the credentials and one place for Meta's
 *  error codes. */
async function acknowledge(to: string, text: string): Promise<void> {
  // An acknowledgement that fails to send must never fail the ingest.
  const result = await sendText(to, text);
  if (!result.ok) console.warn(`whatsapp ack to ${to.slice(-4)}: ${result.error}`);
}

const REPLY: Record<Outcome, (d: Handled) => string> = {
  filed:            (d) => `Logged for booth ${d.stationId}. Thank you.`,
  unknown_sender:   () => '',   // never reply to a stranger
  unparsed:         (d) => `Not logged — ${d.detail}. Format: `
                           + `BOOTH QUEUE PROBLEM PEOPLE, e.g. "10234 med none 3".`,
  unknown_booth:    (d) => `Not logged — ${d.detail}. Check the booth number.`,
  duplicate_report: () => 'Already logged.',
  ignored:          () => '',
};

/**
 * POST from Meta. Verify, extract, file each message, acknowledge.
 *
 * Returns 200 even when individual messages fail, because a non-200 makes
 * Meta retry the whole delivery - and a delivery containing one unparseable
 * message would then be retried forever. The failures are recorded in
 * inbound_message and surfaced by v_ingest_exceptions, which is where a
 * human should see them, rather than in an HTTP status nobody reads.
 */
export async function postWebhook(ctx: Ctx): Promise<void> {
  const raw = await readRaw(ctx.req);

  if (!signatureValid(raw, ctx.req.headers['x-hub-signature-256'] as string | undefined)) {
    // Deliberately terse. An attacker probing this endpoint learns nothing
    // about why they failed.
    throw new HttpError(401, 'Bad signature');
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }

  const messages = extractTexts(payload);

  // Acknowledge the delivery immediately, then process. Meta expects a
  // prompt 200 and will retry if the handler is slow; the work itself is
  // short but a batch of fifty should not be done inside the request.
  json(ctx.res, 200, { received: messages.length });

  for (const msg of messages) {
    try {
      const handled = await handleOne(msg);
      const reply = REPLY[handled.outcome](handled);
      if (reply) await acknowledge(msg.from, reply);
    } catch (error) {
      console.error('whatsapp ingest failed', msg.wamid, (error as Error).message);
    }
  }
}

// ------------------------------------------------------------ roster admin

export async function getRoster(ctx: Ctx): Promise<void> {
  const { rows } = await pool.query(
    `SELECT phone, display_name, station_id, enabled,
            last_message_at, added_by, added_at
       FROM reporter_roster ORDER BY enabled DESC, display_name`);
  json(ctx.res, 200, { as_of: new Date().toISOString(), data: rows });
}

export async function getExceptions(ctx: Ctx): Promise<void> {
  const [exceptions, rate] = await Promise.all([
    pool.query('SELECT * FROM v_ingest_exceptions LIMIT 200'),
    pool.query('SELECT * FROM v_ingest_rate'),
  ]);
  json(ctx.res, 200, {
    as_of: new Date().toISOString(),
    data: { exceptions: exceptions.rows, rate: rate.rows[0] ?? null },
  });
}

/** Bulk roster load. Without this the allowlist is an empty table that
 *  refuses everybody, so it is part of standing ingest up, not an extra.
 *
 *  Takes the shape HQ will actually have: a pasted list of
 *  "name, phone" lines out of a spreadsheet. */
export async function postRoster(ctx: Ctx): Promise<void> {
  requireRole(ctx, 'admin');
  const body = await readJson<{ text?: string; enabled?: boolean }>(ctx.req);
  if (typeof body.text !== 'string') throw new HttpError(400, 'text required');

  const added: string[] = [];
  const updated: string[] = [];
  const refused: Array<{ line: string; reason: string }> = [];

  for (const line of body.text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    // "Name, 082 123 4567" or "082 123 4567, Name" or tab-separated
    const parts = trimmed.split(/[,;\t]/).map((p) => p.trim()).filter(Boolean);
    if (parts.length < 2) { refused.push({ line: trimmed, reason: 'need name and phone' }); continue; }

    const phoneRaw = parts.find((p) => /\d{7,}/.test(p.replace(/\D/g, '')));
    const name = parts.find((p) => p !== phoneRaw);
    if (!phoneRaw || !name) { refused.push({ line: trimmed, reason: 'no phone number found' }); continue; }

    const phone = toE164(phoneRaw);
    if (!phone) { refused.push({ line: trimmed, reason: `"${phoneRaw}" is not a phone number` }); continue; }

    try {
      /* xmax is zero on a fresh insert and non-zero on the conflict path, so
         this distinguishes a marshal newly added from one already on the
         roster. Without it both count as "added", and an operator who pastes
         the same list twice is told it loaded twice — which, when the list is
         several hundred names, is the difference between believing the roster
         is complete and knowing it is. */
      const r = await pool.query<{ inserted: boolean }>(
        `INSERT INTO reporter_roster (phone, display_name, added_by, enabled)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (phone) DO UPDATE
           SET display_name = EXCLUDED.display_name,
               enabled      = EXCLUDED.enabled
         RETURNING (xmax = 0) AS inserted`,
        [phone, name, ctx.userId ?? 'unknown', body.enabled !== false]);
      if (r.rows[0]?.inserted) added.push(phone); else updated.push(phone);
    } catch (error) {
      refused.push({ line: trimmed, reason: (error as Error).message });
    }
  }

  json(ctx.res, 201, { data: { added: added.length, updated: updated.length, refused } });
}

export const whatsapp = {
  getWebhook, postWebhook, getRoster, postRoster, getExceptions,
};
