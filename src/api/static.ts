import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import type { ServerResponse } from 'node:http';

const ROOT = resolve(process.env.PUBLIC_DIR ?? 'public');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
};

/**
 * Serve the dashboard. Returns false when the path is not a static file, so
 * the caller can fall through to the API router or a 404.
 *
 * Any path that escapes the public directory after normalising is refused
 * outright rather than resolved: traversal is the one thing a static
 * handler has to get right.
 */
export async function serveStatic(pathname: string, res: ServerResponse): Promise<boolean> {
  if (pathname.startsWith('/api/')) return false;

  const requested = pathname === '/' ? '/index.html' : pathname;
  const candidate = resolve(join(ROOT, normalize(requested)));
  if (candidate !== ROOT && !candidate.startsWith(ROOT + '/')) return false;

  let size: number;
  try {
    const info = await stat(candidate);
    if (!info.isFile()) return false;
    size = info.size;
  } catch {
    return false;
  }

  const type = TYPES[extname(candidate).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, {
    'content-type': type,
    'content-length': size,
    'x-content-type-options': 'nosniff',
    // The dashboard is small and changes with every deploy; a short cache
    // avoids serving a stale bundle against a changed API.
    'cache-control': extname(candidate) === '.html' ? 'no-store' : 'max-age=300',
  });
  createReadStream(candidate).pipe(res);
  return true;
}
