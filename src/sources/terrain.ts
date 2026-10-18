import { inflateSync } from 'node:zlib';

/* Elevation, for the viewshed screen.
 *
 * WHY THIS IS SERVER-SIDE. The terrarium tiles are public and keyless, but
 * the bucket sends no Access-Control-Allow-Origin, so a browser that draws
 * one to a canvas cannot read the pixels back - the canvas is tainted and
 * getImageData throws. The elevation therefore has to be decoded here and
 * handed over as numbers. That also means it can be cached once instead of
 * re-fetched on every pan.
 *
 * TERRARIUM ENCODING. Each pixel carries a height in its RGB channels:
 *   metres = R * 256 + G + B / 256 - 32768
 * which gives a 1/256 m quantum over a range that covers the sea floor.
 *
 * A NOTE FOR THE LONDON DEMO. London is flat - roughly 0 to 40 m across the
 * whole demo area. The terrain will barely occlude anything, and a viewshed
 * computed against it alone will look generous. What actually blocks a street
 * camera in London is buildings, and buildings are not in this height field.
 * The screen says so rather than letting the picture imply otherwise.
 */

const TILE = 256;
const TILE_URL = (z: number, x: number, y: number) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

/** Decodes an 8-bit truecolour non-interlaced PNG to raw RGB bytes.
 *
 *  Deliberately narrow: terrarium tiles are always colour type 2, bit depth
 *  8, interlace 0, and a decoder that handles exactly that is ~60 lines and
 *  no dependency. It throws rather than guessing if a tile is ever anything
 *  else, because silently misreading a height field produces a plausible
 *  wrong landscape, which is the worst kind of wrong. */
export function decodePngRgb(buffer: Buffer): { width: number; height: number; rgb: Buffer } {
  if (buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new Error('not a PNG');
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const bitDepth = buffer[24];
  const colourType = buffer[25];
  const interlace = buffer[28];
  if (bitDepth !== 8 || colourType !== 2 || interlace !== 0) {
    throw new Error(`unsupported PNG (depth ${bitDepth}, colour ${colourType}, interlace ${interlace})`);
  }

  const idat: Buffer[] = [];
  let offset = 8;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') idat.push(buffer.subarray(offset + 8, offset + 8 + length));
    if (type === 'IEND') break;
    offset += 12 + length;
  }

  const raw = inflateSync(Buffer.concat(idat));
  const bpp = 3;
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);

  // Un-filter, per PNG spec 9.2. Each scanline is prefixed with its filter.
  for (let row = 0; row < height; row += 1) {
    const filter = raw[row * (stride + 1)]!;
    const inRow = row * (stride + 1) + 1;
    const outRow = row * stride;
    for (let i = 0; i < stride; i += 1) {
      const x = raw[inRow + i]!;
      const a = i >= bpp ? out[outRow + i - bpp]! : 0;          // left
      const b = row > 0 ? out[outRow - stride + i]! : 0;        // up
      const c = row > 0 && i >= bpp ? out[outRow - stride + i - bpp]! : 0; // up-left
      let value: number;
      switch (filter) {
        case 0: value = x; break;
        case 1: value = x + a; break;
        case 2: value = x + b; break;
        case 3: value = x + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          value = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`unknown PNG filter ${filter}`);
      }
      out[outRow + i] = value & 0xff;
    }
  }
  return { width, height, rgb: out };
}

const lonToTileX = (lon: number, z: number) => ((lon + 180) / 360) * 2 ** z;
const latToTileY = (lat: number, z: number) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};

/* Tiles are fetched once and kept. The demo looks at one small area over and
 * over, so this turns a screen refresh from sixteen network round trips into
 * none. Bounded so a wandering bbox cannot grow it without limit. */
const cache = new Map<string, Float32Array>();
const CACHE_LIMIT = 64;

async function tileHeights(z: number, x: number, y: number): Promise<Float32Array> {
  const key = `${z}/${x}/${y}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const response = await fetch(TILE_URL(z, x, y), {
    headers: { 'user-agent': 'venom/0.1 (ward analytics)' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`terrain tile ${key}: HTTP ${response.status}`);

  const { rgb } = decodePngRgb(Buffer.from(await response.arrayBuffer()));
  const heights = new Float32Array(TILE * TILE);
  for (let i = 0; i < TILE * TILE; i += 1) {
    const o = i * 3;
    heights[i] = rgb[o]! * 256 + rgb[o + 1]! + rgb[o + 2]! / 256 - 32768;
  }

  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  cache.set(key, heights);
  return heights;
}

export interface TerrainGrid {
  size: number;
  south: number; west: number; north: number; east: number;
  zoom: number;
  min: number; max: number;
  /** Row-major, north row first, `size * size` metres above sea level. */
  heights: number[];
}

/** Samples a regular lat/lon grid over the bbox, bilinearly interpolated from
 *  the tile pixels so the mesh comes out smooth rather than terraced. */
export async function terrainGrid(
  bbox: { south: number; west: number; north: number; east: number },
  size = 128,
): Promise<TerrainGrid> {
  const span = Math.max(bbox.north - bbox.south, bbox.east - bbox.west);
  // Pick the zoom whose pixels are a little finer than the sample spacing,
  // then clamp: below 10 the detail is gone, above 15 a small bbox pulls
  // dozens of tiles for no visible gain.
  const zoom = Math.max(10, Math.min(15,
    Math.round(Math.log2((360 / span) * (size / TILE)) + 1)));

  const needed = new Set<string>();
  const sample = (lat: number, lon: number) => ({
    fx: lonToTileX(lon, zoom) * TILE,
    fy: latToTileY(lat, zoom) * TILE,
  });
  for (const lat of [bbox.south, bbox.north]) {
    for (const lon of [bbox.west, bbox.east]) {
      const { fx, fy } = sample(lat, lon);
      needed.add(`${Math.floor(fx / TILE)}/${Math.floor(fy / TILE)}`);
    }
  }
  // Fill the rectangle between the corner tiles.
  const xs = [...needed].map((k) => Number(k.split('/')[0]));
  const ys = [...needed].map((k) => Number(k.split('/')[1]));
  const tiles = new Map<string, Float32Array>();
  for (let x = Math.min(...xs); x <= Math.max(...xs); x += 1) {
    for (let y = Math.min(...ys); y <= Math.max(...ys); y += 1) {
      tiles.set(`${x}/${y}`, await tileHeights(zoom, x, y));
    }
  }

  const at = (px: number, py: number): number => {
    const tx = Math.floor(px / TILE), ty = Math.floor(py / TILE);
    const tile = tiles.get(`${tx}/${ty}`);
    if (!tile) return 0;
    const ix = Math.min(TILE - 1, Math.max(0, Math.floor(px - tx * TILE)));
    const iy = Math.min(TILE - 1, Math.max(0, Math.floor(py - ty * TILE)));
    return tile[iy * TILE + ix] ?? 0;
  };

  const heights: number[] = [];
  let min = Infinity, max = -Infinity;
  for (let row = 0; row < size; row += 1) {
    const lat = bbox.north - ((bbox.north - bbox.south) * row) / (size - 1);
    for (let col = 0; col < size; col += 1) {
      const lon = bbox.west + ((bbox.east - bbox.west) * col) / (size - 1);
      const { fx, fy } = sample(lat, lon);
      // Bilinear across the four surrounding pixels.
      const x0 = Math.floor(fx - 0.5), y0 = Math.floor(fy - 0.5);
      const dx = fx - 0.5 - x0, dy = fy - 0.5 - y0;
      const h =
        at(x0, y0) * (1 - dx) * (1 - dy) +
        at(x0 + 1, y0) * dx * (1 - dy) +
        at(x0, y0 + 1) * (1 - dx) * dy +
        at(x0 + 1, y0 + 1) * dx * dy;
      heights.push(Math.round(h * 100) / 100);
      if (h < min) min = h;
      if (h > max) max = h;
    }
  }

  return { size, ...bbox, zoom, min, max, heights };
}
