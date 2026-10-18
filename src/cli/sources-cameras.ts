import { recorded } from '../sources/promote.js';
import { fetchTflCameras, fetchOsmCameras, promoteCameras } from '../sources/cameras.js';
import { pool } from '../db.js';

/* Fills the camera cache for the viewshed screen.
 *
 *   npm run sources:cameras
 *   npm run sources:cameras -- --bbox 51.495,-0.145,51.525,-0.095
 *
 * Run this occasionally, not on a schedule and never from a request handler.
 * TfL is a single call for all of London. Overpass is frequently at capacity
 * and asks for exponential backoff, so a failure there is expected and does
 * not fail the run - TfL alone is enough to draw the screen. */

const bboxArg = process.argv.indexOf('--bbox');
const parts = bboxArg === -1 ? [] : (process.argv[bboxArg + 1] ?? '').split(',').map(Number);
const bbox = parts.length === 4 && parts.every(Number.isFinite)
  ? { south: parts[0]!, west: parts[1]!, north: parts[2]!, east: parts[3]! }
  // Central London: Westminster through the City, where OSM coverage is best.
  : { south: 51.495, west: -0.145, north: 51.525, east: -0.095 };

const tfl = await recorded('tfl_jamcams', async (c) => {
  const { rows, seen } = await fetchTflCameras();
  const kept = await promoteCameras(c, rows);
  return { result: kept, seen, kept };
});
console.log(tfl.run.ok
  ? `TfL JamCams: ${tfl.run.itemsSeen} seen, ${tfl.run.itemsKept} cameras cached`
  : `TfL JamCams failed: ${tfl.run.error}`);

const osm = await recorded('osm_overpass', async (c) => {
  const { rows, seen } = await fetchOsmCameras(bbox);
  const kept = await promoteCameras(c, rows);
  return { result: kept, seen, kept };
});
console.log(osm.run.ok
  ? `OSM surveillance: ${osm.run.itemsSeen} seen, ${osm.run.itemsKept} cameras cached`
  : `OSM surveillance unavailable: ${osm.run.error}`);

const { rows } = await pool.query(
  `SELECT bearing_basis, count(*)::int AS n FROM camera GROUP BY 1 ORDER BY 1`);
console.log('cached by bearing basis:',
  rows.map((r) => `${r.bearing_basis} ${r.n}`).join(', ') || 'none');

await pool.end();
// TfL alone is a usable screen; only a total failure is worth a bad exit.
process.exit(tfl.run.ok || osm.run.ok ? 0 : 1);
