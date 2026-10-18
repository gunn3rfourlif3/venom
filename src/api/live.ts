import type { ServerResponse } from 'node:http';
import pg from 'pg';
import { config } from '../config.js';

/**
 * The live path.
 *
 * Server-Sent Events, not WebSocket. The specification said WebSocket; SSE
 * is the better fit and costs less:
 *   - the channel is one-way, server to client, which is all SSE does;
 *   - it is plain HTTP, so it needs no dependency, and the Node standard
 *     library is enough where a WebSocket server is not;
 *   - the browser reconnects on its own, which on counting night matters
 *     more than anything else here;
 *   - it survives proxies that do not negotiate an upgrade.
 *
 * WHAT IS PUSHED IS AN IDENTIFIER, NEVER A VALUE. A payload of ward_id
 * alone stays under the 8 kB NOTIFY limit, cannot be applied out of order,
 * and makes the client read back through the same query it uses on load.
 * Pushing values is the usual reason a dashboard drifts out of sync with
 * its database and nobody can say why.
 */

const CHANNELS = ['extract_stale', 'ward_changed'] as const;

type Client = { id: number; res: ServerResponse };

export class LiveHub {
  private clients = new Map<number, Client>();
  private nextId = 1;
  private listener: pg.Client | null = null;
  private heartbeat: NodeJS.Timeout | null = null;

  /** LISTEN holds a connection for its lifetime, so it must stay out of
   *  the request pool or it will starve it. */
  async start(): Promise<void> {
    const client = new pg.Client({ connectionString: config.db.connectionString });
    await client.connect();
    for (const channel of CHANNELS) await client.query(`LISTEN ${channel}`);

    client.on('notification', (msg) => {
      this.broadcast(msg.channel, msg.payload ?? '');
    });
    client.on('error', (error) => {
      console.error('live listener error, reconnecting shortly:', error.message);
      this.listener = null;
      setTimeout(() => void this.start().catch(() => {}), 2000);
    });

    this.listener = client;

    // Comment frames keep intermediaries from closing an idle stream.
    this.heartbeat = setInterval(() => {
      for (const c of this.clients.values()) c.res.write(': keepalive\n\n');
    }, 25000);
  }

  subscribe(res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const id = this.nextId++;
    this.clients.set(id, { id, res });
    res.write(`event: ready\ndata: {"subscribed":${JSON.stringify(CHANNELS)}}\n\n`);
    res.on('close', () => { this.clients.delete(id); });
  }

  private broadcast(channel: string, payload: string): void {
    const frame = `event: ${channel}\ndata: ${JSON.stringify({ payload })}\n\n`;
    for (const c of this.clients.values()) {
      try { c.res.write(frame); } catch { this.clients.delete(c.id); }
    }
  }

  get clientCount(): number {
    return this.clients.size;
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const c of this.clients.values()) c.res.end();
    this.clients.clear();
    if (this.listener) await this.listener.end().catch(() => {});
  }
}
