/**
 * Venom API.
 *
 * Reads are the bulk of it and nothing here computes a figure: every number
 * served is already a column in a view. If the dashboard needs something
 * that is not, it belongs in a view - that is the whole point of keeping
 * the lineage.
 *
 * Three endpoints write, all of them logistics: booth reports (append-only,
 * from our own marshals) and deployment arrival. Everything else still
 * arrives by spreadsheet import or the control panel.
 *
 *   npm run build && npm run api
 */
import { createServer } from 'node:http';
import { pool } from '../db.js';
import { HttpError, json, type Ctx } from './http.js';
import { routes } from './routes.js';
import { logistics } from './logistics.js';
import { whatsapp } from './whatsapp.js';
import { slips } from './slips.js';
import { transcribe } from './transcribe.js';
import { hashtags } from './hashtags.js';
import { purgeExpiredSessions } from './auth.js';
import { LiveHub } from './live.js';
import { serveStatic } from './static.js';
import { wardIdParam } from './http.js';

const PORT = Number(process.env.API_PORT ?? 8080);
const hub = new LiveHub();

type Handler = (ctx: Ctx) => Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  handler: (ctx: Ctx, ...params: string[]) => Promise<void>;
  open?: boolean;   // reachable without a session
}

const table: Route[] = [
  { method: 'GET',  pattern: /^\/api\/health$/, open: true,
    handler: async (ctx) => { json(ctx.res, 200, { ok: true, live_clients: hub.clientCount }); } },

  { method: 'POST', pattern: /^\/api\/auth\/login$/,  open: true, handler: routes.postLogin },
  { method: 'POST', pattern: /^\/api\/auth\/logout$/, open: true, handler: routes.postLogout },
  { method: 'GET',  pattern: /^\/api\/me$/,           handler: routes.getMe },

  { method: 'GET',  pattern: /^\/api\/wards$/,        handler: routes.getWards },
  { method: 'GET',  pattern: /^\/api\/wards\/([^/]+)$/,
    handler: async (ctx, id) => routes.getWard(ctx, wardIdParam(id ?? '')) },
  { method: 'GET',  pattern: /^\/api\/targets$/,      handler: routes.getTargets },
  { method: 'GET',  pattern: /^\/api\/campaign$/,     handler: routes.getCampaign },
  { method: 'GET',  pattern: /^\/api\/float$/,        handler: routes.getFloat },
  { method: 'GET',  pattern: /^\/api\/decisions$/,    handler: routes.getDecisions },
  { method: 'GET',  pattern: /^\/api\/documents$/,    handler: routes.getDocuments },
  { method: 'GET',  pattern: /^\/api\/sentiment$/,     handler: routes.getSentiment },
  { method: 'GET',  pattern: /^\/api\/ingest-health$/, handler: routes.getIngestHealth },
  { method: 'GET',  pattern: /^\/api\/search$/,        handler: routes.getSearch },
  { method: 'GET',  pattern: /^\/api\/cameras$/,       handler: routes.getCameras },
  { method: 'GET',  pattern: /^\/api\/terrain$/,       handler: routes.getTerrain },
  { method: 'GET',  pattern: /^\/api\/overview$/,      handler: routes.getOverview },
  { method: 'GET',  pattern: /^\/api\/control-panel$/, handler: routes.getControlPanel },
  { method: 'PUT',  pattern: /^\/api\/control-panel$/, handler: routes.putControlPanel },

  { method: 'GET',  pattern: /^\/api\/logistics$/,   handler: logistics.getLogistics },
  { method: 'GET',  pattern: /^\/api\/call-sheet$/,  handler: logistics.getCallSheet },
  { method: 'GET',  pattern: /^\/api\/booth-reports\/([^/]+)$/,
    handler: async (ctx, id) => logistics.getStationReports(ctx, id ?? '') },
  { method: 'POST', pattern: /^\/api\/booth-reports\/parse$/, handler: logistics.postParse },
  { method: 'POST', pattern: /^\/api\/booth-reports$/,        handler: logistics.postReports },
  { method: 'PATCH', pattern: /^\/api\/deployments\/([^/]+)$/,
    handler: async (ctx, id) => logistics.patchDeployment(ctx, id ?? '') },

  // Meta calls these, so they carry no session. The POST is authenticated by
  // the X-Hub-Signature-256 HMAC instead, and the GET by the verify token.
  { method: 'GET',  pattern: /^\/api\/whatsapp\/webhook$/, open: true,
    handler: whatsapp.getWebhook },
  { method: 'POST', pattern: /^\/api\/whatsapp\/webhook$/, open: true,
    handler: whatsapp.postWebhook },
  { method: 'GET',  pattern: /^\/api\/alerts$/,            handler: logistics.getAlerts },
  { method: 'POST', pattern: /^\/api\/alerts\/([^/]+)\/ack$/,
    handler: async (ctx, id) => logistics.postAlertAck(ctx, id ?? '') },

  /* Result-slip capture. The marshal's two routes carry no session — they are
     authenticated by the token in the request, because a marshal has no
     account (migration 030). The image route is session-authenticated and
     role-gated like everything else. */
  { method: 'POST', pattern: /^\/api\/slip$/,              open: true,
    handler: slips.postSlip },
  { method: 'GET',  pattern: /^\/api\/slip\/stations$/,    open: true,
    handler: slips.getCaptureStations },
  { method: 'GET',  pattern: /^\/api\/slip\/([0-9]+)\/image$/,
    handler: async (ctx, id) => slips.getSlipImage(ctx, id ?? '') },

  { method: 'GET',  pattern: /^\/api\/transcribe\/next$/, handler: transcribe.getNext },
  { method: 'POST', pattern: /^\/api\/transcribe$/,        handler: transcribe.postPass },
  { method: 'GET',  pattern: /^\/api\/slips\/overview$/,  handler: transcribe.getOverview },

  { method: 'GET',   pattern: /^\/api\/trending$/, handler: routes.getTrending },
  { method: 'GET',   pattern: /^\/api\/station-map$/, handler: routes.getStationMap },
  { method: 'GET',   pattern: /^\/api\/heat$/, handler: routes.getHeat },
  { method: 'GET',   pattern: /^\/api\/heat\/detail$/, handler: routes.getHeatDetail },
  { method: 'GET',   pattern: /^\/api\/register-completeness$/,
    handler: routes.getRegisterCompleteness },
  { method: 'GET',   pattern: /^\/api\/briefing$/, handler: routes.getBriefing },
  { method: 'GET',   pattern: /^\/api\/hashtags$/, handler: hashtags.getHashtags },
  { method: 'POST',  pattern: /^\/api\/hashtags$/, handler: hashtags.postHashtags },
  { method: 'PATCH', pattern: /^\/api\/hashtags\/([A-Za-z0-9_]+)$/,
    handler: async (ctx, tag) => hashtags.patchHashtag(ctx, tag ?? '') },

  { method: 'GET',  pattern: /^\/api\/roster$/,            handler: whatsapp.getRoster },
  { method: 'POST', pattern: /^\/api\/roster$/,            handler: whatsapp.postRoster },
  { method: 'GET',  pattern: /^\/api\/ingest-exceptions$/, handler: whatsapp.getExceptions },

  { method: 'GET',  pattern: /^\/api\/live$/,
    handler: async (ctx) => { hub.subscribe(ctx.res); } },
];

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const ctx: Ctx = { req, res, url };

  try {
    // the dashboard first; anything under /api/ falls through to the router
    if (req.method === 'GET' && await serveStatic(url.pathname, res)) return;

    const route = table.find(
      (r) => r.method === req.method && r.pattern.test(url.pathname));
    if (!route) throw new HttpError(404, 'No such endpoint');

    if (!route.open) await routes.authenticate(ctx);

    const match = route.pattern.exec(url.pathname);
    await route.handler(ctx, ...(match ?? []).slice(1));
  } catch (error) {
    if (error instanceof HttpError) {
      json(res, error.status, { error: error.message });
    } else {
      // The client gets nothing useful about the inside of the system.
      console.error('unhandled:', error);
      if (!res.headersSent) json(res, 500, { error: 'Internal error' });
    }
  }
});

async function main(): Promise<void> {
  await hub.start();
  setInterval(() => { void purgeExpiredSessions().catch(() => {}); }, 3600_000);
  server.listen(PORT, () => {
    console.log(`venom listening on :${PORT} — dashboard at /`);
  });
}

async function shutdown(): Promise<void> {
  console.log('shutting down');
  server.close();
  await hub.stop();
  await pool.end();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
