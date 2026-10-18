import type { PoolClient } from 'pg';

/* Public camera installations, from the two publishers that actually serve
 * them without a key.
 *
 * Nothing here invents a camera. If both sources are unreachable the table
 * stays empty and the viewshed screen says so, because a demonstration built
 * on made-up positions would teach the wrong thing about a screen whose whole
 * claim is "this is where the cameras are".
 */

export interface CameraRow {
  sourceId: string;
  externalId: string;
  name: string | null;
  lat: number;
  lon: number;
  bearingDeg: number | null;
  bearingBasis: 'TAGGED' | 'PARSED' | 'UNKNOWN';
  fovDeg: number | null;
  rangeM: number | null;
  mountHeightM: number | null;
  cameraType: string | null;
  sourceUrl: string | null;
}

/* ASSUMPTIONS, in one place so they can be argued with.
 *
 * Neither publisher gives field of view, range or mount height, so these are
 * keyed to camera type and nothing more. A fixed street camera sees a cone;
 * a dome can swing anywhere and is drawn as a full circle because pretending
 * to know where it points would be worse than admitting it could be
 * anywhere. Ranges are the distance at which a person is still resolvable on
 * a typical installation, not the distance at which the lens stops. */
const ASSUMED: Record<string, { fov: number; range: number; height: number }> = {
  fixed:   { fov: 60,  range: 60, height: 5 },
  panning: { fov: 120, range: 80, height: 6 },
  dome:    { fov: 360, range: 45, height: 4 },
  traffic: { fov: 55,  range: 120, height: 7 },
  default: { fov: 70,  range: 60, height: 5 },
};

const COMPASS: Array<[RegExp, number]> = [
  [/\bnorth[\s-]?east\b|\bnortheast\b|\bne\b/, 45],
  [/\bsouth[\s-]?east\b|\bsoutheast\b|\bse\b/, 135],
  [/\bsouth[\s-]?west\b|\bsouthwest\b|\bsw\b/, 225],
  [/\bnorth[\s-]?west\b|\bnorthwest\b|\bnw\b/, 315],
  [/\bnorth\b|\bnorthbound\b|\bn\/b\b/, 0],
  [/\beast\b|\beastbound\b|\be\/b\b/, 90],
  [/\bsouth\b|\bsouthbound\b|\bs\/b\b/, 180],
  [/\bwest\b|\bwestbound\b|\bw\/b\b/, 270],
];

/** Pulls a compass bearing out of free text. Compound directions are tested
 *  before single ones, or "north east" matches "north" and loses 45 degrees. */
export function bearingFromText(text: string | null | undefined): number | null {
  if (!text) return null;
  const s = text.toLowerCase();
  for (const [pattern, degrees] of COMPASS) if (pattern.test(s)) return degrees;
  return null;
}

/** OSM camera:direction is either degrees or a cardinal name. */
export function bearingFromOsm(raw: string | undefined): number | null {
  if (!raw) return null;
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber)) return ((asNumber % 360) + 360) % 360;
  return bearingFromText(raw);
}

/* ------------------------------------------------------- TfL JamCams */

interface TflPlace {
  id: string;
  commonName?: string;
  lat: number;
  lon: number;
  additionalProperties?: Array<{ key?: string; value?: string }>;
}

export async function fetchTflCameras(): Promise<{ rows: CameraRow[]; seen: number }> {
  const url = 'https://api.tfl.gov.uk/Place/Type/JamCam';
  const response = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'venom/0.1 (ward analytics)' },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`TfL JamCams: HTTP ${response.status}`);

  const places = await response.json() as TflPlace[];
  const assumed = ASSUMED['traffic']!;

  const rows = places.map((place) => {
    const prop = (key: string) =>
      place.additionalProperties?.find((p) => p.key === key)?.value;
    const bearing = bearingFromText(prop('view'));
    return {
      sourceId: 'tfl_jamcams',
      externalId: place.id,
      name: place.commonName ?? null,
      lat: place.lat,
      lon: place.lon,
      bearingDeg: bearing,
      bearingBasis: (bearing === null ? 'UNKNOWN' : 'PARSED') as CameraRow['bearingBasis'],
      fovDeg: assumed.fov,
      rangeM: assumed.range,
      mountHeightM: assumed.height,
      cameraType: 'traffic',
      sourceUrl: url,
    } satisfies CameraRow;
  }).filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon));

  return { rows, seen: places.length };
}

/* --------------------------------------------------- OSM via Overpass */

const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface OverpassNode {
  id: number; lat: number; lon: number; tags?: Record<string, string>;
}

/** One bounded fetch, across mirrors, with the exponential backoff Overpass
 *  explicitly asks for when it returns 502 at capacity. Called by a CLI, not
 *  by a request handler: the browser must never reach this. */
export async function fetchOsmCameras(
  bbox: { south: number; west: number; north: number; east: number },
  attemptsPerMirror = 3,
): Promise<{ rows: CameraRow[]; seen: number }> {
  const query = `[out:json][timeout:80];
node["man_made"="surveillance"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
out body;`;

  let lastStatus = 0;
  for (const mirror of OVERPASS_MIRRORS) {
    for (let attempt = 1; attempt <= attemptsPerMirror; attempt += 1) {
      const response = await fetch(mirror, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          // Overpass returns 406 without a real User-Agent.
          'user-agent': 'venom/0.1 (ward analytics; one-off cache fill)',
        },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(120_000),
      }).catch(() => null);

      if (response?.ok) {
        const body = await response.json() as { elements?: OverpassNode[] };
        const nodes = body.elements ?? [];
        const rows = nodes
          .filter((n) => Number.isFinite(n.lat) && Number.isFinite(n.lon))
          .map((node) => {
            const tags = node.tags ?? {};
            const bearing = bearingFromOsm(tags['camera:direction']);
            const type = tags['camera:type'] ?? 'default';
            const assumed = ASSUMED[type] ?? ASSUMED['default']!;
            const height = Number(tags['height']);
            return {
              sourceId: 'osm_overpass',
              externalId: String(node.id),
              name: tags['name'] ?? tags['operator'] ?? null,
              lat: node.lat,
              lon: node.lon,
              bearingDeg: bearing,
              bearingBasis: (bearing === null ? 'UNKNOWN' : 'TAGGED') as CameraRow['bearingBasis'],
              fovDeg: assumed.fov,
              rangeM: assumed.range,
              // Height is the one assumption a publisher sometimes overrides.
              mountHeightM: Number.isFinite(height) ? height : assumed.height,
              cameraType: tags['camera:type'] ?? null,
              sourceUrl: `https://www.openstreetmap.org/node/${node.id}`,
            } satisfies CameraRow;
          });
        return { rows, seen: nodes.length };
      }

      lastStatus = response?.status ?? 0;
      // 504/502 mean "at capacity, come back later" - their words.
      await sleep(Math.min(30_000, 4000 * 2 ** (attempt - 1)));
    }
  }
  throw new Error(
    `Overpass unavailable across ${OVERPASS_MIRRORS.length} mirrors (last status ${lastStatus}). ` +
    'The public endpoints are frequently at capacity; this is a cache fill, so retry later.');
}

/* ------------------------------------------------------------- write */

export async function promoteCameras(
  client: PoolClient, rows: CameraRow[],
): Promise<number> {
  let written = 0;
  for (const c of rows) {
    const result = await client.query(
      `INSERT INTO camera
         (source_id, external_id, name, lat, lon, bearing_deg, bearing_basis,
          fov_deg, range_m, mount_height_m, camera_type, estimated,
          source_url, retrieved_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::bearing_basis,$8,$9,$10,$11,true,$12,now())
       ON CONFLICT (source_id, external_id) DO UPDATE
         SET name = EXCLUDED.name, lat = EXCLUDED.lat, lon = EXCLUDED.lon,
             bearing_deg = EXCLUDED.bearing_deg,
             bearing_basis = EXCLUDED.bearing_basis,
             fov_deg = EXCLUDED.fov_deg, range_m = EXCLUDED.range_m,
             mount_height_m = EXCLUDED.mount_height_m,
             camera_type = EXCLUDED.camera_type,
             source_url = EXCLUDED.source_url, retrieved_at = now()`,
      [c.sourceId, c.externalId, c.name, c.lat, c.lon, c.bearingDeg, c.bearingBasis,
       c.fovDeg, c.rangeM, c.mountHeightM, c.cameraType, c.sourceUrl]);
    written += result.rowCount ?? 0;
  }
  return written;
}
