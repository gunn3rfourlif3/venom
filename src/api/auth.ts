import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { ServerResponse } from 'node:http';
import { pool } from '../db.js';
import { HttpError, parseCookies, type Ctx } from './http.js';

const scrypt = promisify(scryptCb) as (
  password: string, salt: Buffer, keylen: number,
) => Promise<Buffer>;

const SESSION_COOKIE = 'venom_session';
const SESSION_HOURS = 12;

/** scrypt$<salt hex>$<hash hex>, stored whole so the scheme can change
 *  later without a migration. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  const scheme = parts[0], saltHex = parts[1], hashHex = parts[2];
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export interface LoggedIn {
  sessionId: string; userId: string; role: string; displayName: string;
}

export async function login(
  email: string, password: string, userAgent: string | undefined,
): Promise<LoggedIn> {
  const result = await pool.query(
    `SELECT user_id, role, display_name, password_hash, is_active
       FROM app_user WHERE lower(email) = lower($1)`,
    [email],
  );
  const user = result.rows[0];

  // Verify against a dummy when the account is absent, so a missing user and
  // a wrong password take the same time to answer.
  const stored = user?.password_hash ?? `scrypt$${'00'.repeat(16)}$${'00'.repeat(64)}`;
  const ok = await verifyPassword(password, stored);
  if (!user || !user.is_active || !ok) throw new HttpError(401, 'Invalid credentials');

  const sessionId = randomBytes(32).toString('hex');
  await pool.query(
    `INSERT INTO session (session_id, user_id, expires_at, user_agent)
     VALUES ($1, $2, now() + ($3 || ' hours')::interval, $4)`,
    [sessionId, user.user_id, String(SESSION_HOURS), userAgent?.slice(0, 300) ?? null],
  );
  await pool.query('UPDATE app_user SET last_login_at = now() WHERE user_id = $1', [user.user_id]);

  return { sessionId, userId: user.user_id, role: user.role, displayName: user.display_name };
}

export async function logout(sessionId: string): Promise<void> {
  await pool.query('DELETE FROM session WHERE session_id = $1', [sessionId]);
}

export function setSessionCookie(res: ServerResponse, sessionId: string, secure: boolean): void {
  res.setHeader('set-cookie',
    `${SESSION_COOKIE}=${sessionId}; HttpOnly; SameSite=Strict; Path=/; ` +
    `Max-Age=${SESSION_HOURS * 3600}${secure ? '; Secure' : ''}`);
}

export function clearSessionCookie(res: ServerResponse, secure: boolean): void {
  res.setHeader('set-cookie',
    `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? '; Secure' : ''}`);
}

export function sessionIdFrom(ctx: Ctx): string | undefined {
  return parseCookies(ctx.req.headers.cookie)[SESSION_COOKIE];
}

export async function authenticate(ctx: Ctx): Promise<void> {
  const sessionId = sessionIdFrom(ctx);
  if (!sessionId) throw new HttpError(401, 'Not signed in');

  const result = await pool.query(
    `SELECT u.user_id, u.role, u.is_active
       FROM session s JOIN app_user u ON u.user_id = s.user_id
      WHERE s.session_id = $1 AND s.expires_at > now()`,
    [sessionId],
  );
  const row = result.rows[0];
  if (!row || !row.is_active) throw new HttpError(401, 'Session expired');

  await pool.query('UPDATE session SET last_seen_at = now() WHERE session_id = $1', [sessionId]);
  ctx.userId = row.user_id;
  ctx.role = row.role;
}

const RANK: Record<string, number> = { viewer: 0, reporter: 1, treasurer: 2, admin: 3 };

export function requireRole(ctx: Ctx, minimum: string): void {
  const have = RANK[ctx.role ?? 'viewer'] ?? 0;
  const need = RANK[minimum] ?? 0;
  if (have < need) throw new HttpError(403, 'Insufficient role');
}

export async function purgeExpiredSessions(): Promise<number> {
  const result = await pool.query('DELETE FROM session WHERE expires_at < now()');
  return result.rowCount ?? 0;
}
