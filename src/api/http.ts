import type { IncomingMessage, ServerResponse } from 'node:http';

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  userId?: string;
  role?: string;
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

export async function readJson<T>(req: IncomingMessage, limitBytes = 64000): Promise<T> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > limitBytes) throw new HttpError(413, 'Body too large');
    chunks.push(chunk as Buffer);
  }
  if (total === 0) return {} as T;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

/** The raw bytes, not the parsed object.
 *
 *  Needed because a signed webhook is signed over the exact bytes sent.
 *  JSON.parse followed by JSON.stringify does not reproduce them - key
 *  order, whitespace and unicode escaping all move - so a signature checked
 *  against a re-serialised body fails for correct requests and, worse, could
 *  be made to pass for incorrect ones. */
export async function readRaw(
  req: IncomingMessage, limitBytes = 1_048_576,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > limitBytes) throw new HttpError(413, 'Body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

/** Bounded integer from a query string, so a client cannot ask for the world. */
export function intParam(
  url: URL, name: string, fallback: number, min: number, max: number,
): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new HttpError(400, `${name} must be an integer`);
  return Math.min(max, Math.max(min, value));
}

/** Every value still goes through a parameterised query; this only keeps
 *  obvious junk out of the round trip. */
export function wardIdParam(value: string): string {
  if (!/^[A-Za-z0-9-]{1,32}$/.test(value)) throw new HttpError(400, 'Bad ward id');
  return value;
}

export function enumParam(
  url: URL, name: string, allowed: readonly string[],
): string | null {
  const raw = url.searchParams.get(name);
  if (raw === null) return null;
  if (!allowed.includes(raw)) {
    throw new HttpError(400, `${name} must be one of: ${allowed.join(', ')}`);
  }
  return raw;
}
