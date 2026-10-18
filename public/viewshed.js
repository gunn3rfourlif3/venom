/* 3D viewshed projection.
 *
 * WHAT IS REAL HERE. Camera positions, from Transport for London's open
 * traffic-camera feed and OpenStreetMap's surveillance nodes. Terrain, from
 * public terrarium elevation tiles. Bearings, where a publisher gave one.
 *
 * WHAT IS NOT. Field of view, range and mount height. Neither publisher
 * records them, so they are assumptions keyed to camera type and the screen
 * labels them as such. A camera with no published bearing is drawn as a ring,
 * not a wedge pointing in a direction nobody stated.
 *
 * AND WHAT THE PICTURE LEAVES OUT. The line-of-sight test below is real - it
 * marches each azimuth across the height field and stops at the first ridge
 * that blocks it - but London is flat, so terrain almost never blocks
 * anything. What actually limits a street camera here is buildings, and there
 * are no buildings in this height field. Read the wedges as "where this
 * camera is pointed", not "what this camera can see".
 *
 * Three.js is loaded on demand, so a session that never opens this screen
 * never fetches it.
 */

const THREE_URL = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/0.169.0/three.module.min.js';

const DEFAULT_BBOX = { south: 51.495, west: -0.145, north: 51.525, east: -0.095 };

const state = {
  THREE: null, renderer: null, scene: null, camera: null,
  frame: null, teardown: [], exaggeration: 6, built: false,
};

const token = (name, fallback) => {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
};

/* ------------------------------------------------------------ helpers */

/** Bilinear sample of the height grid in grid space. Clamped at the edges so
 *  a camera just outside the sampled area still gets a sane ground height
 *  instead of dropping to zero and floating. */
function sampleHeight(grid, size, gx, gz) {
  const cx = Math.max(0, Math.min(size - 1.001, gx));
  const cz = Math.max(0, Math.min(size - 1.001, gz));
  const x0 = Math.floor(cx), z0 = Math.floor(cz);
  const fx = cx - x0, fz = cz - z0;
  const at = (c, r) => grid[r * size + c] ?? 0;
  return at(x0, z0) * (1 - fx) * (1 - fz)
       + at(x0 + 1, z0) * fx * (1 - fz)
       + at(x0, z0 + 1) * (1 - fx) * fz
       + at(x0 + 1, z0 + 1) * fx * fz;
}

/** Minimal orbit control. Written rather than imported because the addon
 *  lives outside the single-file CDN build, and rotate-plus-zoom is forty
 *  lines that will not break when a CDN path changes. */
function orbit(THREE, camera, element, target, startRadius) {
  let radius = startRadius, theta = -0.6, phi = 0.95, dragging = false, lastX = 0, lastY = 0;

  const apply = () => {
    phi = Math.max(0.12, Math.min(Math.PI / 2 - 0.02, phi));
    camera.position.set(
      target.x + radius * Math.sin(phi) * Math.sin(theta),
      target.y + radius * Math.cos(phi),
      target.z + radius * Math.sin(phi) * Math.cos(theta));
    camera.lookAt(target);
  };

  const down = (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; };
  const up = () => { dragging = false; };
  const move = (e) => {
    if (!dragging) return;
    theta -= (e.clientX - lastX) * 0.005;
    phi -= (e.clientY - lastY) * 0.005;
    lastX = e.clientX; lastY = e.clientY;
    apply();
  };
  const wheel = (e) => {
    e.preventDefault();
    radius = Math.max(startRadius * 0.1, Math.min(startRadius * 4,
      radius * (1 + Math.sign(e.deltaY) * 0.12)));
    apply();
  };

  element.addEventListener('pointerdown', down);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointermove', move);
  element.addEventListener('wheel', wheel, { passive: false });
  apply();

  return () => {
    element.removeEventListener('pointerdown', down);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointermove', move);
    element.removeEventListener('wheel', wheel);
  };
}

/* ------------------------------------------------------------- build */

function buildTerrain(THREE, terrain, metres, exaggeration) {
  const { size, heights } = terrain;
  const positions = new Float32Array(size * size * 3);
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      const i = (r * size + c) * 3;
      positions[i] = (c / (size - 1)) * metres.width;
      positions[i + 1] = (heights[r * size + c] ?? 0) * exaggeration;
      positions[i + 2] = (r / (size - 1)) * metres.height;
    }
  }
  const indices = [];
  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const a = r * size + c, b = a + 1, d = a + size, e = d + 1;
      indices.push(a, d, b, b, d, e);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  const group = new THREE.Group();
  group.add(new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({
    color: new THREE.Color(token('--surface-2', '#16222c')),
    flatShading: false,
  })));
  // A hairline wire over the fill: the register draws, it does not render.
  group.add(new THREE.LineSegments(
    new THREE.WireframeGeometry(geometry),
    new THREE.LineBasicMaterial({
      color: new THREE.Color(token('--rule', '#2a3b48')),
      transparent: true, opacity: 0.35,
    })));
  return group;
}

/** The viewshed itself: per-azimuth ray marching against the height field.
 *
 *  All wedges go into one geometry. Four hundred separate meshes is four
 *  hundred draw calls a frame for something that never moves. */
function buildWedges(THREE, cameras, terrain, metres, exaggeration) {
  const { size, heights } = terrain;
  const latSpan = terrain.north - terrain.south;
  const lonSpan = terrain.east - terrain.west;

  const vertices = [];
  const counts = { TAGGED: 0, PARSED: 0, UNKNOWN: 0, offGrid: 0 };

  for (const cam of cameras) {
    const gx = ((cam.lon - terrain.west) / lonSpan) * (size - 1);
    const gz = ((terrain.north - cam.lat) / latSpan) * (size - 1);
    if (gx < 0 || gz < 0 || gx > size - 1 || gz > size - 1) { counts.offGrid += 1; continue; }

    const x = (gx / (size - 1)) * metres.width;
    const z = (gz / (size - 1)) * metres.height;
    const ground = sampleHeight(heights, size, gx, gz);
    const eye = ground + (cam.mount_height_m ?? 5);

    const known = cam.bearing_deg !== null && cam.bearing_deg !== undefined;
    counts[cam.bearing_basis] = (counts[cam.bearing_basis] ?? 0) + 1;

    // No published bearing means no claim about direction: a full circle, so
    // the eye reads "somewhere around here" rather than "that way".
    const fov = known ? (cam.fov_deg ?? 70) : 360;
    const range = cam.range_m ?? 60;
    const centre = known ? cam.bearing_deg : 0;

    const steps = Math.max(8, Math.round(fov / 4));
    const marchSteps = 20;
    const reach = [];

    for (let s = 0; s <= steps; s += 1) {
      const azimuth = ((centre - fov / 2 + (fov * s) / steps) * Math.PI) / 180;
      const dx = Math.sin(azimuth), dz = -Math.cos(azimuth);
      let maxSlope = -Infinity;
      let clipped = range;

      for (let m = 1; m <= marchSteps; m += 1) {
        const d = (range * m) / marchSteps;
        const h = sampleHeight(heights, size,
          gx + (dx * d * (size - 1)) / metres.width,
          gz + (dz * d * (size - 1)) / metres.height);
        const slope = (h - eye) / d;
        if (slope >= maxSlope) { maxSlope = slope; } else { clipped = d; break; }
      }
      reach.push({ dx, dz, d: clipped });
    }

    // Lifted a little so it does not z-fight with the ground it describes.
    const lift = 1.5 * exaggeration;
    for (let s = 0; s < reach.length - 1; s += 1) {
      const a = reach[s], b = reach[s + 1];
      const ax = x + a.dx * a.d, az = z + a.dz * a.d;
      const bx = x + b.dx * b.d, bz = z + b.dz * b.d;
      const ah = sampleHeight(heights, size,
        (ax / metres.width) * (size - 1), (az / metres.height) * (size - 1));
      const bh = sampleHeight(heights, size,
        (bx / metres.width) * (size - 1), (bz / metres.height) * (size - 1));
      vertices.push(
        x, ground * exaggeration + lift, z,
        ax, ah * exaggeration + lift, az,
        bx, bh * exaggeration + lift, bz);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position',
    new THREE.BufferAttribute(new Float32Array(vertices), 3));

  // Additive, so overlapping cones brighten. Where the screen glows, several
  // cameras are pointed at the same street - which is the thing worth seeing.
  const material = new THREE.MeshBasicMaterial({
    color: new THREE.Color(token('--focus', '#6aa9e0')),
    transparent: true, opacity: 0.16, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  return { mesh: new THREE.Mesh(geometry, material), counts };
}

function buildMarkers(THREE, cameras, terrain, metres, exaggeration) {
  const { size, heights } = terrain;
  const latSpan = terrain.north - terrain.south;
  const lonSpan = terrain.east - terrain.west;
  const positions = [];

  for (const cam of cameras) {
    const gx = ((cam.lon - terrain.west) / lonSpan) * (size - 1);
    const gz = ((terrain.north - cam.lat) / latSpan) * (size - 1);
    if (gx < 0 || gz < 0 || gx > size - 1 || gz > size - 1) continue;
    positions.push(
      (gx / (size - 1)) * metres.width,
      (sampleHeight(heights, size, gx, gz) + (cam.mount_height_m ?? 5)) * exaggeration,
      (gz / (size - 1)) * metres.height);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position',
    new THREE.BufferAttribute(new Float32Array(positions), 3));
  return new THREE.Points(geometry, new THREE.PointsMaterial({
    color: new THREE.Color(token('--ink', '#e7eef3')),
    size: 4, sizeAttenuation: false,
  }));
}

/* -------------------------------------------------------------- show */

async function render(bbox) {
  const host = document.getElementById('viewshed-canvas');
  const note = document.getElementById('viewshed-note');
  note.textContent = 'Loading terrain and cameras…';

  if (!state.THREE) state.THREE = await import(THREE_URL);
  const THREE = state.THREE;

  const query = `south=${bbox.south}&west=${bbox.west}&north=${bbox.north}&east=${bbox.east}`;
  const [terrainRes, camerasRes] = await Promise.all([
    fetch(`/api/terrain?${query}&size=128`, { credentials: 'same-origin' }),
    fetch(`/api/cameras?${query}&limit=600`, { credentials: 'same-origin' }),
  ]);
  if (!terrainRes.ok) throw new Error(`terrain: HTTP ${terrainRes.status}`);
  if (!camerasRes.ok) throw new Error(`cameras: HTTP ${camerasRes.status}`);

  const terrain = (await terrainRes.json()).data;
  const cameras = (await camerasRes.json()).data;

  if (cameras.length === 0) {
    note.innerHTML = '<strong>No cameras cached.</strong> Run <code>npm run sources:cameras</code>. '
      + 'Nothing is drawn from invented positions, so the scene stays empty until a publisher supplies them.';
    return;
  }

  const midLat = (terrain.north + terrain.south) / 2;
  const metres = {
    width: (terrain.east - terrain.west) * 111320 * Math.cos((midLat * Math.PI) / 180),
    height: (terrain.north - terrain.south) * 111320,
  };

  // Tear down any previous scene before building another.
  teardown();

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setSize(host.clientWidth, host.clientHeight);
  renderer.setClearColor(new THREE.Color(token('--paper', '#0d161d')), 1);
  host.appendChild(renderer.domElement);

  // Framing and fog both scale with the ground covered, so a wider or
  // narrower bbox arrives composed instead of clipped or lost in the middle.
  const diagonal = Math.hypot(metres.width, metres.height);
  const startRadius = diagonal * 0.78;

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(
    new THREE.Color(token('--paper', '#0d161d')), diagonal * 0.75, diagonal * 2.2);
  scene.add(new THREE.AmbientLight(0xffffff, 1.5));
  const key = new THREE.DirectionalLight(0xffffff, 1.1);
  key.position.set(-1, 2, 1);
  scene.add(key);

  const exaggeration = state.exaggeration;
  scene.add(buildTerrain(THREE, terrain, metres, exaggeration));
  const { mesh: wedges, counts } = buildWedges(THREE, cameras, terrain, metres, exaggeration);
  scene.add(wedges);
  scene.add(buildMarkers(THREE, cameras, terrain, metres, exaggeration));

  const camera = new THREE.PerspectiveCamera(
    45, host.clientWidth / host.clientHeight, 1, diagonal * 8);
  const target = new THREE.Vector3(
    metres.width / 2,
    ((terrain.min + terrain.max) / 2) * exaggeration,
    metres.height / 2);
  const stopOrbit = orbit(THREE, camera, host, target, startRadius);

  const resize = () => {
    renderer.setSize(host.clientWidth, host.clientHeight);
    camera.aspect = host.clientWidth / host.clientHeight;
    camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', resize);

  const loop = () => {
    state.frame = requestAnimationFrame(loop);
    renderer.render(scene, camera);
  };
  loop();

  state.renderer = renderer;
  state.teardown = [
    stopOrbit,
    () => window.removeEventListener('resize', resize),
    () => { renderer.dispose(); host.innerHTML = ''; },
  ];

  const drawn = counts.TAGGED + counts.PARSED;
  note.innerHTML =
    `<strong>${cameras.length} cameras</strong> over ${terrain.min.toFixed(0)}–`
    + `${terrain.max.toFixed(0)} m of terrain, vertical exaggeration ×${exaggeration}. `
    + `${drawn} have a published or parseable bearing and are drawn as wedges; `
    + `${counts.UNKNOWN} do not and are drawn as full circles, because the publisher stated no direction. `
    + 'Field of view, range and mount height are assumptions keyed to camera type &mdash; '
    + 'no publisher records them. Buildings are not modelled, so coverage reads optimistic.';

  document.getElementById('viewshed-counts').innerHTML = [
    ['Tagged bearing', counts.TAGGED, 'publisher stated a direction'],
    ['Parsed bearing', counts.PARSED, 'read out of free text'],
    ['No bearing', counts.UNKNOWN, 'drawn as a full circle'],
  ].map(([label, n, why]) =>
    `<div class="vs-stat"><span class="vs-n">${n}</span>
       <span class="vs-label">${label}</span><span class="vs-why">${why}</span></div>`).join('');
}

function teardown() {
  if (state.frame) cancelAnimationFrame(state.frame);
  state.frame = null;
  for (const fn of state.teardown) { try { fn(); } catch { /* going away anyway */ } }
  state.teardown = [];
  state.renderer = null;
}

export async function show() {
  const note = document.getElementById('viewshed-note');
  try {
    await render(DEFAULT_BBOX);
    state.built = true;
  } catch (error) {
    teardown();
    note.innerHTML = `<strong>Could not draw the projection.</strong> ${
      String(error.message).replace(/[<>]/g, '')}`;
  }
}

export function hide() { teardown(); state.built = false; }

export async function setExaggeration(value) {
  state.exaggeration = value;
  if (state.built) await show();
}

window.VenomViewshed = { show, hide, setExaggeration };
