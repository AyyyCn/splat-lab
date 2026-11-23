
// ------------------------------------------------------------------ world: splats + collider
let collider = null;
let splatMesh = null;
let worldInfo = { flipped: false, colliderTurned: false, scale: 1, fit: 0 };
let spawnAt = new THREE.Vector3();
const worldRoot = new THREE.Group();
scene.add(worldRoot);
// Worlds in play: [0] is the one you start in; with a portal open, [1] is the world on the other side, parked
// 400 m away so the two never overlap. The globals above always describe the world you're standing in.
const worlds = [];
let act = 0;
const worldRootB = new THREE.Group();
scene.add(worldRootB);
let splatBytes = { loaded: 0, total: 0 };
const draco = new DRACOLoader().setDecoderPath("https://cdn.jsdelivr.net/npm/three@0.180.0/examples/jsm/libs/draco/gltf/");
const CAM_HEIGHT = 1.6; // a generated world's origin is the camera it was made from: stand it at eye height

function unloadWorld() {
  closePortal();
  for (const w of worlds) {
    w.splat.parent?.remove(w.splat); w.splat.dispose();
    if (w.collider) { scene.remove(w.collider); w.collider.geometry.dispose(); }
  }
  worlds.length = 0; act = 0; splatMesh = null; collider = null; hitGrid = null;
  for (const s of snares) world.remove(s.group);
  snares.length = 0;
  if (scene.environment) { scene.environment.dispose(); scene.environment = null; }
}

// Drawing cost is per splat, not per pixel: 3.5M splats took ~13 ms a frame on this Mac however small the
// window. Worlds over budget keep only their most visible splats (opacity times size); the ones dropped are
// faint specks and haze that barely show, especially through the footage noise.
async function pruneSplats(splat, budget) {
  const ps = splat.packedSplats, N = ps?.numSplats ?? 0;
  if (!ps || N <= budget) return { splat, dropped: 0 };
  const imp = new Float32Array(N);
  splat.forEachSplat((i, c, s, q, o) => { imp[i] = o * Math.sqrt(s.x * s.y + s.y * s.z + s.x * s.z); });
  const S = 200000, sample = new Float32Array(S);
  for (let k = 0; k < S; k++) sample[k] = imp[Math.floor((k * N) / S)];
  sample.sort();
  const cut = sample[Math.floor(S * (1 - budget / N))];
  let n = 0;
  for (let i = 0; i < N; i++) if (imp[i] >= cut) n++;
  const cap = Math.ceil(n / 2048) * 2048;
  const src = ps.packedArray, out = new Uint32Array(cap * 4);
  // spherical-harmonic extras (if a file has them) are per splat too, so they're compacted alongside
  const srcCap = src.length / 4, extra = {};
  for (const [key, arr] of Object.entries(ps.extra || {})) if (arr && arr.length) extra[key] = { arr, w: arr.length / srcCap, out: new arr.constructor(cap * (arr.length / srcCap)) };
  for (let i = 0, j = 0; i < N; i++) {
    if (imp[i] < cut) continue;
    out.set(src.subarray(i * 4, i * 4 + 4), j * 4);
    for (const e of Object.values(extra)) e.out.set(e.arr.subarray(i * e.w, i * e.w + e.w), j * e.w);
    j++;
  }
  const packed = new PackedSplats({ packedArray: out, numSplats: n, splatEncoding: ps.splatEncoding, extra: Object.fromEntries(Object.entries(extra).map(([k, e]) => [k, e.out])) });
  const mesh = new SplatMesh({ packedSplats: packed });
  await mesh.initialized;
  splat.dispose();
  return { splat: mesh, dropped: N - n };
}
// ------------------------------------------------------------------ collision built from the splats themselves
// Scans (phone captures, trained 3DGS files) come without a collision mesh, so one is built from the splats:
// opaque splat centres are binned into ~10 cm voxels, and a voxel with a couple of solid splats in it is solid.
// Holes in the floor (shiny or unseen patches) are patched from the floor around them. Every face between a
// solid and an empty voxel becomes two triangles, and the result is used exactly like a generated collider:
// walking, ground probes, snare placement, torch shadows, bullet hits.
// InteriorGS ships a top-down occupancy map of each scene (255 walkable, 0 occupied, 127 unknown) with a JSON
// giving its bounds in the file's own z-up metres; read it as a grey grid
async function loadOccupancy(o) {
  const text = (x) => (x instanceof File ? x.text() : fetch(x).then((r) => { if (!r.ok) throw new Error(r.status); return r.text(); }));
  const blob = (x) => (x instanceof File ? Promise.resolve(x) : fetch(x).then((r) => { if (!r.ok) throw new Error(r.status); return r.blob(); }));
  const [meta, img] = await Promise.all([text(o.json).then(JSON.parse), blob(o.png).then((b) => createImageBitmap(b))]);
  const c = new OffscreenCanvas(img.width, img.height), g = c.getContext("2d");
  g.drawImage(img, 0, 0);
  const rgba = g.getImageData(0, 0, img.width, img.height).data, grey = new Uint8Array(img.width * img.height);
  for (let i = 0; i < grey.length; i++) grey[i] = rgba[i * 4];
  return { w: img.width, h: img.height, grey, scale: meta.scale, min: meta.min, max: meta.max };
}
function splatCollider(splat, M, voxel, occ) {
  const e = M.elements, P = new THREE.Vector3();
  const tx = (c) => P.set(e[0] * c.x + e[4] * c.y + e[8] * c.z + e[12], e[1] * c.x + e[5] * c.y + e[9] * c.z + e[13], e[2] * c.x + e[6] * c.y + e[10] * c.z + e[14]);
  const N = splat.packedSplats?.numSplats ?? splat.numSplats ?? 0, stride = Math.max(1, Math.floor(N / 60000));
  // bounds from a sample, ignoring the outermost 1% each way (floaters, distant haze)
  const xs = [], ys = [], zs = [];
  splat.forEachSplat((i, c, s, q, o) => { if (i % stride || o < 0.35) return; tx(c); xs.push(P.x); ys.push(P.y); zs.push(P.z); });
  for (const a of [xs, ys, zs]) a.sort((u, w) => u - w);
  const pct = (a, p) => a[Math.floor((a.length - 1) * p)];
  const lo = new THREE.Vector3(pct(xs, 0.01), pct(ys, 0.01), pct(zs, 0.01)).subScalar(0.5);
  const hi = new THREE.Vector3(pct(xs, 0.99), pct(ys, 0.99), pct(zs, 0.99)).addScalar(0.5);
  const size = hi.clone().sub(lo);
  let v = voxel;
  while ((size.x / v) * (size.y / v) * (size.z / v) > 40e6) v *= 1.25; // keep the grid under ~40M cells
  const nx = Math.ceil(size.x / v), ny = Math.ceil(size.y / v), nz = Math.ceil(size.z / v);
  const at = (x, y, z) => (y * nz + z) * nx + x;
  const cell = new Uint8Array(nx * ny * nz);
  splat.forEachSplat((i, c, s, q, o) => {
    if (o < 0.35) return;
    tx(c);
    const x = Math.floor((P.x - lo.x) / v), y = Math.floor((P.y - lo.y) / v), z = Math.floor((P.z - lo.z) / v);
    if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) return;
    const k = at(x, y, z);
    if (cell[k] < 255) cell[k]++;
  });
  for (let k = 0; k < cell.length; k++) cell[k] = cell[k] >= 2 ? 1 : 0; // one stray splat isn't a wall
  const solid = (x, y, z) => x >= 0 && y >= 0 && z >= 0 && x < nx && y < ny && z < nz && cell[at(x, y, z)] === 1;
  // the floor: the lowest solid voxel of each column; holes are filled from their neighbours, a ring per pass
  const floor = new Int32Array(nx * nz).fill(-1);
  for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) for (let y = 0; y < ny; y++) if (cell[at(x, y, z)]) { floor[z * nx + x] = y; break; }
  let patched = 0;
  for (let pass = 0; pass < 8; pass++) {
    const add = [];
    for (let z = 1; z < nz - 1; z++) for (let x = 1; x < nx - 1; x++) {
      if (floor[z * nx + x] >= 0) continue;
      const nb = [];
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) { const f = floor[(z + dz) * nx + x + dx]; if ((dx || dz) && f >= 0) nb.push(f); }
      if (nb.length >= 5) { nb.sort((a, b) => a - b); add.push([x, z, nb[nb.length >> 1]]); }
    }
    if (!add.length) break;
    for (const [x, z, f] of add) { floor[z * nx + x] = f; cell[at(x, f, z)] = 1; patched++; }
  }
  // faces between solid and empty voxels
  const dirs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  let faces = 0;
  for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
    if (!cell[at(x, y, z)]) continue;
    for (const [dx, dy, dz] of dirs) if (!solid(x + dx, y + dy, z + dz)) faces++;
  }
  const pos = new Float32Array(faces * 18);
  let n = 0;
  const put = (x, y, z) => { pos[n++] = lo.x + x * v; pos[n++] = lo.y + y * v; pos[n++] = lo.z + z * v; };
  for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
    if (!cell[at(x, y, z)]) continue;
    for (const [dx, dy, dz] of dirs) {
      if (solid(x + dx, y + dy, z + dz)) continue;
      // the square on that side of the voxel, as two triangles
      // the face's corner, then the two axes it spans (the ones it isn't facing along)
      const fx = x + (dx > 0 ? 1 : 0), fy = y + (dy > 0 ? 1 : 0), fz = z + (dz > 0 ? 1 : 0);
      const u = dx ? [0, 1, 0] : [1, 0, 0], w = dz ? [0, 1, 0] : [0, 0, 1];
      const c0 = [fx, fy, fz], c1 = [fx + u[0], fy + u[1], fz + u[2]], c2 = [fx + u[0] + w[0], fy + u[1] + w[1], fz + u[2] + w[2]], c3 = [fx + w[0], fy + w[1], fz + w[2]];
      put(...c0); put(...c1); put(...c2); put(...c0); put(...c2); put(...c3);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  // a start point with room to move: mark each floor column blocked if anything stands between knee and head
  // height above it, measure every free column's distance to the nearest blocked one (a 2D distance transform),
  // then take the roomiest spot, preferring ones near the middle of the scan
  const lowBand = Math.max(1, Math.round(0.2 / v)), head = Math.ceil(1.8 / v);
  const clear = new Float32Array(nx * nz);
  for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
    const f = floor[z * nx + x];
    let blocked = f < 0;
    for (let y = f + lowBand; !blocked && y <= f + head && y < ny; y++) if (cell[at(x, y, z)]) blocked = true;
    clear[z * nx + x] = blocked ? 0 : 1e9;
  }
  const D = Math.SQRT2;
  for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) { // chamfer pass, top-left to bottom-right
    const k = z * nx + x; let d = clear[k];
    if (x > 0) d = Math.min(d, clear[k - 1] + 1);
    if (z > 0) d = Math.min(d, clear[k - nx] + 1);
    if (x > 0 && z > 0) d = Math.min(d, clear[k - nx - 1] + D);
    if (x < nx - 1 && z > 0) d = Math.min(d, clear[k - nx + 1] + D);
    clear[k] = d;
  }
  for (let z = nz - 1; z >= 0; z--) for (let x = nx - 1; x >= 0; x--) { // and back
    const k = z * nx + x; let d = clear[k];
    if (x < nx - 1) d = Math.min(d, clear[k + 1] + 1);
    if (z < nz - 1) d = Math.min(d, clear[k + nx] + 1);
    if (x < nx - 1 && z < nz - 1) d = Math.min(d, clear[k + nx + 1] + D);
    if (x > 0 && z < nz - 1) d = Math.min(d, clear[k + nx - 1] + D);
    clear[k] = d;
  }
  // ...but only on the main floor level (the most common floor height), and indoors if the scan has a roof:
  // open space outside a building or up on its roof is roomy too
  const hist = new Map();
  for (const f of floor) if (f >= 0) hist.set(f, (hist.get(f) || 0) + 1);
  let mainF = 0, mainN = -1;
  for (const [f, n] of hist) { const near = n + (hist.get(f - 1) || 0) + (hist.get(f + 1) || 0); if (near > mainN) { mainN = near; mainF = f; } }
  const roofReach = Math.ceil(5 / v);
  const covered = (x, z, f) => { for (let y = f + head + 1; y <= f + roofReach && y < ny; y++) if (cell[at(x, y, z)]) return true; return false; };
  // indoors also means walls around you: look 8 m in eight directions at chest height, and want six hits
  const reach = Math.ceil(8 / v), chest = Math.round(1.2 / v);
  const enclosed = (x, z, f) => {
    let hits = 0;
    for (let k = 0; k < 8; k++) {
      const dx = Math.cos((k * Math.PI) / 4), dz = Math.sin((k * Math.PI) / 4);
      for (let t = 1; t <= reach; t++) if (solid(Math.round(x + dx * t), f + chest, Math.round(z + dz * t))) { hits++; break; }
    }
    return hits >= 6;
  };
  const indoors = (x, z, f) => covered(x, z, f) && enclosed(x, z, f);
  let anyCovered = false;
  for (let z = 0; z < nz && !anyCovered; z++) for (let x = 0; x < nx && !anyCovered; x++) {
    const f = floor[z * nx + x];
    if (f >= 0 && Math.abs(f - mainF) <= 3 && clear[z * nx + x] * v >= 0.5 && indoors(x, z, f)) anyCovered = true;
  }
  const mx = pct(xs, 0.5), mz = pct(zs, 0.5);
  let best = null, bestScore = -Infinity;
  for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
    const c = clear[z * nx + x] * v; // metres to the nearest obstacle
    if (c < 0.5) continue;
    const f = floor[z * nx + x];
    if (Math.abs(f - mainF) > 3) continue;
    if (anyCovered && !indoors(x, z, f)) continue;
    const wx = lo.x + (x + 0.5) * v, wz = lo.z + (z + 0.5) * v;
    const score = Math.min(c, 1.5) - 0.06 * Math.hypot(wx - mx, wz - mz); // roomy first, central second
    if (score > bestScore) { bestScore = score; best = [wx, lo.y + (f + 1) * v + 0.05, wz]; }
  }
  if (occ) {
    const fromMap = occupancySpawn(occ, M, (wx, wz) => {
      const x = Math.floor((wx - lo.x) / v), z = Math.floor((wz - lo.z) / v);
      return x >= 0 && z >= 0 && x < nx && z < nz ? { clear: clear[z * nx + x] * v, floorY: floor[z * nx + x] >= 0 ? lo.y + (floor[z * nx + x] + 1) * v : null } : null;
    });
    if (fromMap) best = fromMap;
  }
  return { geo, voxel: v, tris: faces * 2, patched, spawn: best };
}
// The start point from an occupancy map: the walkable pixel furthest from anything, preferring the middle of
// the walkable area. Image rows may run either way along the map's y axis, so both readings are tried and the
// one that agrees better with the collision built from the splats wins.
function occupancySpawn(occ, M, voxelAt) {
  const { w, h, grey, scale } = occ, [x0, y0] = occ.min, [x1, y1] = occ.max;
  const D = Math.SQRT2;
  // room around each walkable pixel (a two-pass chamfer distance transform)
  const dist = new Float32Array(w * h);
  for (let k = 0; k < dist.length; k++) dist[k] = grey[k] === 255 ? 1e9 : 0;
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    const k = r * w + c; let d = dist[k];
    if (c > 0) d = Math.min(d, dist[k - 1] + 1);
    if (r > 0) d = Math.min(d, dist[k - w] + 1, c > 0 ? dist[k - w - 1] + D : 1e9, c < w - 1 ? dist[k - w + 1] + D : 1e9);
    dist[k] = d;
  }
  for (let r = h - 1; r >= 0; r--) for (let c = w - 1; c >= 0; c--) {
    const k = r * w + c; let d = dist[k];
    if (c < w - 1) d = Math.min(d, dist[k + 1] + 1);
    if (r < h - 1) d = Math.min(d, dist[k + w] + 1, c < w - 1 ? dist[k + w + 1] + D : 1e9, c > 0 ? dist[k + w - 1] + D : 1e9);
    dist[k] = d;
  }
  // the map calls outdoors walkable too. Flood in from its edges through roomy pixels only (over 55 cm clear):
  // doorways are too narrow to pass, so whatever roomy floor the flood doesn't reach is indoors
  const roomy = (k) => dist[k] * scale > 0.55;
  const outside = new Uint8Array(w * h), stack = [];
  for (let c = 0; c < w; c++) stack.push(c, (h - 1) * w + c);
  for (let r = 0; r < h; r++) stack.push(r * w, r * w + w - 1);
  while (stack.length) {
    const k = stack.pop();
    if (outside[k] || !roomy(k)) continue;
    outside[k] = 1;
    const c = k % w, r = (k - c) / w;
    if (c > 0) stack.push(k - 1); if (c < w - 1) stack.push(k + 1); if (r > 0) stack.push(k - w); if (r < h - 1) stack.push(k + w);
  }
  let inside = 0;
  for (let k = 0; k < w * h; k++) if (roomy(k) && !outside[k]) inside++;
  const usable = (k) => grey[k] === 255 && (!inside || !outside[k]);
  // which way round does the map sit on the splats? (InteriorGS maps come out mirrored left-to-right.) Try the
  // four flips: walkable pixels should land on open floor, occupied ones shouldn't
  const P = new THREE.Vector3();
  const toWorld = (c, r, fx, fy) => P.set(fx ? x1 - (c + 0.5) * scale : x0 + (c + 0.5) * scale, fy ? y1 - (r + 0.5) * scale : y0 + (r + 0.5) * scale, 0).applyMatrix4(M);
  let pick = [1, 0], bestFit = -Infinity;
  for (const fx of [0, 1]) for (const fy of [0, 1]) {
    let fit = 0;
    for (let n = 0; n < 6000; n++) {
      const k = Math.floor(Math.random() * w * h), g = grey[k];
      if (g === 127) continue;
      toWorld(k % w, Math.floor(k / w), fx, fy);
      const at = voxelAt(P.x, P.z), open = !!at && at.clear > 0.15;
      fit += g === 255 ? (open ? 1 : 0) : (open ? -1 : 0);
    }
    if (fit > bestFit) { bestFit = fit; pick = [fx, fy]; }
  }
  // roomiest usable spot, preferring the middle of the building (the occupied pixels' centre)
  let cx = 0, cy = 0, n = 0;
  for (let k = 0; k < w * h; k++) if (grey[k] === 0) { cx += k % w; cy += Math.floor(k / w); n++; }
  if (n) { cx /= n; cy /= n; } else { cx = w / 2; cy = h / 2; }
  const cands = [];
  for (let k = 0; k < w * h; k++) {
    if (!usable(k)) continue;
    const room = dist[k] * scale;
    if (room < 0.45) continue;
    cands.push([Math.min(room, 1.2) - 0.12 * Math.hypot(k % w - cx, Math.floor(k / w) - cy) * scale, k]);
  }
  cands.sort((a, b) => b[0] - a[0]);
  // and check each against the collision built from the splats: there must be floor at ground level (the map's
  // z = 0) with room to stand, or it's the next candidate. None at all means the map didn't line up: give up.
  for (const [, k] of cands.slice(0, 600)) {
    toWorld(k % w, Math.floor(k / w), pick[0], pick[1]);
    const at = voxelAt(P.x, P.z);
    if (at && at.floorY != null && Math.abs(at.floorY - P.y) < 0.6 && at.clear > 0.3) return [P.x, at.floorY + 0.05, P.z];
  }
  return null;
}
// Scans are often tilted (a photo reconstruction has no idea which way is up). Fit a plane to the lowest
// splats and, if it's within 30° of level, turn the scan so that plane is the floor.
function levelScan(splat, pts) {
  if (pts.length < 200) return 0;
  const sorted = [...pts].sort((a, b) => a.y - b.y), low = sorted.slice(0, Math.floor(sorted.length * 0.3));
  const span = sorted[Math.floor(sorted.length * 0.95)].y - sorted[Math.floor(sorted.length * 0.05)].y, tol = Math.max(1e-3, span * 0.01);
  const r = mulberry32(17), ab = new THREE.Vector3(), ac = new THREE.Vector3(), nrm = new THREE.Vector3(), d = new THREE.Vector3();
  let best = null, bestN = 0;
  for (let it = 0; it < 400; it++) {
    const a = low[Math.floor(r() * low.length)], b = low[Math.floor(r() * low.length)], c = low[Math.floor(r() * low.length)];
    nrm.crossVectors(ab.subVectors(b, a), ac.subVectors(c, a));
    if (nrm.lengthSq() < 1e-12) continue;
    nrm.normalize();
    if (nrm.y < 0) nrm.negate();
    if (nrm.y < 0.85) continue;
    let k = 0;
    for (const p of low) if (Math.abs(d.subVectors(p, a).dot(nrm)) < tol) k++;
    if (k > bestN) { bestN = k; best = nrm.clone(); }
  }
  if (!best || bestN < low.length * 0.2) return 0;
  const deg = THREE.MathUtils.radToDeg(Math.acos(best.y));
  if (deg < 0.5) return 0;
  const q = new THREE.Quaternion().setFromUnitVectors(best, new THREE.Vector3(0, 1, 0));
  splat.quaternion.premultiply(q);
  for (const p of pts) p.applyQuaternion(q);
  return deg;
}

// Loads a world (URLs or dropped Files) and returns it set up, without touching the live scene.
async function loadWorld(W) {
  splatBytes = { loaded: 0, total: 0 };
  const isFile = (x) => typeof File !== "undefined" && x instanceof File;
  let splat = isFile(W.splat)
    ? new SplatMesh({ fileBytes: new Uint8Array(await W.splat.arrayBuffer()), fileName: W.splat.name })
    : new SplatMesh({ url: W.splat, onProgress: (e) => { splatBytes = { loaded: e.loaded, total: e.total || 0 }; } });
  const gltfLoader = new GLTFLoader().setDRACOLoader(draco);
  const colliderP = !W.collider ? Promise.resolve(null)
    : isFile(W.collider) ? W.collider.arrayBuffer().then((buf) => gltfLoader.parseAsync(buf, ""))
    : gltfLoader.loadAsync(W.collider);
  let [gltf] = await Promise.all([colliderP, splat.initialized]);
  const pruned = await pruneSplats(splat, W.budget ?? RENDER.splats);
  splat = pruned.splat;

  // one pass over the splats: heights for orientation, opaque centres for lining up the collider
  const ys = [], solid = [];
  const stride = Math.max(1, Math.floor((splat.numSplats || 1e6) / 40000));
  splat.forEachSplat((i, c, s, q, o) => {
    if (i % stride) return;
    ys.push(c.y);
    if (o > 0.5 && (i / stride) % 8 === 0) solid.push(new THREE.Vector3(c.x, c.y, c.z));
  });
  // Raw Marble files are y-down (OpenCV), but some exports were already turned y-up. A world's dense
  // layer is its ground and the scene rises from it: if most of the spread is below the median, flip it.
  let flip = W.flip;
  // some files are z-up (InteriorGS, many CAD and scan tools): stand them up first, and skip the y-flip guess
  if (W.up === "z") {
    flip = false;
    splat.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
    for (const p of solid) p.applyQuaternion(splat.quaternion);
  }
  if (flip === "auto") {
    ys.sort((a, b) => a - b);
    const q = (p) => ys[Math.floor((ys.length - 1) * p)];
    flip = q(0.5) - q(0.05) > q(0.95) - q(0.5);
  }
  if (flip === true) { splat.quaternion.set(1, 0, 0, 0); for (const p of solid) p.set(p.x, -p.y, -p.z); }
  // a scan with no collider of its own: level it before building one
  const derive = !gltf;
  const levelled = derive && W.level !== false ? levelScan(splat, solid) : 0;

  let geo = null, turned = false, fit = 0;
  if (gltf) {
    gltf.scene.updateMatrixWorld(true);
    const gen = new StaticGeometryGenerator(gltf.scene);
    gen.attributes = ["position"];
    geo = gen.generate();
    // Some collider files carry their own up-axis fix and some don't. Keep whichever way round puts the
    // mesh on the splats: the median splat-to-surface distance is only small when the two agree.
    const bvh = new MeshBVH(geo), probe = new THREE.Vector3(), hit = {};
    const sampleN = Math.min(solid.length, 2500), step = solid.length / sampleN;
    const medianGap = (sgn) => {
      const d = [];
      for (let k = 0; k < sampleN; k++) {
        const p = solid[Math.floor(k * step)];
        probe.set(p.x, sgn * p.y, sgn * p.z);
        d.push(bvh.closestPointToPoint(probe, hit)?.distance ?? Infinity);
      }
      d.sort((a, b) => a - b);
      return d[d.length >> 1];
    };
    const keep = medianGap(1), turn = medianGap(-1);
    turned = turn < keep;
    fit = Math.min(keep, turn);
    if (turned) geo.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI));
  }

  // Size: the world is generated around its camera, so measure the drop from the origin to the ground
  // and scale that to eye height. Marble's units aren't metres, so this is what makes walking feel right.
  let scale = W.scale;
  if (scale === "auto") {
    scale = 1;
    if (geo) {
      const bvh = new MeshBVH(geo), ray = new THREE.Ray(), down = new THREE.Vector3(0, -1, 0), drops = [];
      for (let k = 0; k < 9; k++) {
        const a = (k / 8) * TAU, r = k ? 0.25 : 0;
        ray.set(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r), down);
        const h = bvh.raycastFirst(ray, THREE.DoubleSide);
        if (h && h.distance > 0.02) drops.push(h.distance);
      }
      drops.sort((a, b) => a - b);
      if (drops.length) scale = THREE.MathUtils.clamp(CAM_HEIGHT / drops[drops.length >> 1], 0.25, 12);
    }
  }

  const root = new THREE.Object3D();
  root.position.set(...W.position);
  root.scale.setScalar(scale);
  root.updateMatrixWorld(true);
  let col = null, built = null;
  if (geo) geo.applyMatrix4(root.matrixWorld);
  else if (derive) {
    // build it in world space: the root's place and size, then the splats' own turn (flip, levelling)
    const M = root.matrixWorld.clone().multiply(new THREE.Matrix4().makeRotationFromQuaternion(splat.quaternion));
    let occ = null;
    if (W.occupancy) try { occ = await loadOccupancy(W.occupancy); } catch (err) { console.warn("No occupancy map:", err); }
    built = splatCollider(splat, M, W.voxel ?? 0.1, occ);
    built.occupancy = !!occ;
    geo = built.geo;
    fit = built.voxel * 0.6 / scale;
  }
  if (geo) {
    geo.boundsTree = new MeshBVH(geo);
    col = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x35ff9a, wireframe: true, transparent: true, opacity: 0.35, depthTest: false }));
    col.visible = false;
    col.renderOrder = 10;
  }
  return { splat, collider: col, position: W.position, info: {
    flipped: flip, colliderTurned: turned, scale, fit: fit * scale, dropped: pruned.dropped, loaded: pruned.dropped + (splat.packedSplats?.numSplats ?? splat.numSplats ?? 0),
    derived: !!built, voxel: built?.voxel, tris: built?.tris, patched: built?.patched, levelled, spawn: built?.spawn ?? null, occupancy: !!built?.occupancy,
  } };
}

// a walkable spot: cast down from above and keep only flat ground near the player's level, not roofs
const _ray = new THREE.Ray(), _down = new THREE.Vector3(0, -1, 0);
function groundAt(x, z, nearY, reach = 3) {
  if (!collider) return null;
  _ray.origin.set(x, nearY + reach, z);
  _ray.direction.copy(_down);
  const hit = collider.geometry.boundsTree.raycastFirst(_ray, THREE.DoubleSide);
  if (!hit || Math.abs(hit.point.y - nearY) > reach) return null;
  return hit;
}

// ------------------------------------------------------------------ player: a capsule pushed out of the collider mesh
const player = {
  pos: new THREE.Vector3(), vel: new THREE.Vector3(), yaw: Math.PI, pitch: -0.05, yawT: Math.PI, pitchT: -0.05,
  phase: 0, steps: 0, fatigue: 0, onGround: false, eyeY: EYE,
};
const CAP = { radius: 0.42, height: 1.7 }; // a bit wide: splats smear into streaks if the lens gets right up to a wall
const seg = new THREE.Line3(), triPoint = new THREE.Vector3(), capPoint = new THREE.Vector3(), capBox = new THREE.Box3(), delta = new THREE.Vector3();
function collide(dt) {
  seg.start.set(player.pos.x, player.pos.y + CAP.radius, player.pos.z);
  seg.end.set(player.pos.x, player.pos.y + CAP.height - CAP.radius, player.pos.z);
  const start0 = seg.start.clone();
  capBox.makeEmpty().expandByPoint(seg.start).expandByPoint(seg.end).expandByScalar(CAP.radius);
  collider.geometry.boundsTree.shapecast({
    intersectsBounds: (box) => box.intersectsBox(capBox),
    intersectsTriangle: (tri) => {
      const d = tri.closestPointToSegment(seg, triPoint, capPoint);
      if (d < CAP.radius) {
        const dir = capPoint.sub(triPoint).normalize();
        const depth = CAP.radius - d;
        seg.start.addScaledVector(dir, depth);
        seg.end.addScaledVector(dir, depth);
      }
    },
  });
  delta.subVectors(seg.start, start0);
  player.onGround = delta.y > Math.abs(dt * player.vel.y * 0.25);
  const off = Math.max(0, delta.length() - 1e-5);
  if (off > 0) {
    delta.normalize();
    player.pos.addScaledVector(delta, off);
    if (!player.onGround) player.vel.addScaledVector(delta, -delta.dot(player.vel));
    else player.vel.y = 0;
  }
}

// ------------------------------------------------------------------ snares, set on open flat ground
const snares = [];
// Generated worlds are small and fall apart toward their edges, so keep the snares within the part of the
// collider that surrounds the start: 80% of its vertices lie within radius R of the player.
function walkableRadius() {
  const p = collider.geometry.attributes.position, d = [];
  for (let i = 0; i < p.count; i += 5) d.push(Math.hypot(p.getX(i) - player.pos.x, p.getZ(i) - player.pos.z));
  d.sort((a, b) => a - b);
  return d[Math.floor(d.length * 0.8)] || 10;
}
function placeSnares() {
  const r = mulberry32(911);
  const y0 = player.pos.y;
  const max = Math.min(27, 0.8 * walkableRadius()), min = Math.min(5, 0.3 * max), gap = Math.min(7, 0.4 * max);
  for (let tries = 0; snares.length < 5 && tries < 6000; tries++) {
    const a = r() * TAU, d = min + r() * (max - min);
    const x = player.pos.x + Math.cos(a) * d, z = player.pos.z + Math.sin(a) * d;
    const hit = groundAt(x, z, y0, 2.5);
    if (!hit || !hit.face) continue;
    const n = hit.face.normal.clone();
    if (Math.abs(n.y) < 0.85) continue; // flat ground only
    if (snares.some((s) => Math.hypot(s.x - x, s.z - z) < gap)) continue;
    // keep it out of walls: the spot needs a little clearance all round
    let blocked = false;
    for (let k = 0; k < 6 && !blocked; k++) {
      const b = (k / 6) * TAU, h = groundAt(x + Math.cos(b) * 0.6, z + Math.sin(b) * 0.6, hit.point.y, 0.5);
      if (!h) blocked = true;
    }
    if (blocked) continue;
    const s = makeSnare();
    s.group.position.set(x, hit.point.y - 0.02, z);
    s.group.rotation.y = r() * TAU;
    world.add(s.group);
    snares.push({ n: snares.length + 1, x, z, cut: false, ...s });
  }
}
// snares are ordinary meshes, so they're lit by an environment captured from the splats around them
// (always in daylight: at night that light is turned down instead)
async function lightSnares() {
  const offline = new SparkRenderer({ renderer, accumExtSplats: RENDER.ext }); // must match the main renderer, or the two share a mismatched splat program
  const center = player.pos.clone(); center.y += 1;
  const was = LIGHT.night.value;
  LIGHT.night.value = 0; splatMesh.needsUpdate = true;
  try {
    const tex = await offline.renderEnvMap({ scene, worldCenter: center, near: 0.05, far: 200, hideObjects: snares.map((s) => s.group) });
    scene.environment = tex;
  } finally { LIGHT.night.value = was; splatMesh.needsUpdate = true; }
}

// ------------------------------------------------------------------ lights out: night and a torch, lit per splat
// Marble bakes daylight into every splat's colour, so there's no light to switch off. At night we turn that
// colour down to faint moonlight and add a torch, lighting each splat at its centre:
//  - brightness from the torch's cone and the inverse square of distance;
//  - which way the surface faces from the splat's own shape (a flat splat's thinnest axis is its normal);
//  - shadows from the collider mesh, drawn into a distance map from the torch every frame.
// It runs on the GPU in Spark's per-splat pipeline, so the splats are re-lit every frame the torch moves.
const TORCH = {
  // held low in the right hand, well off the lens: a torch right beside the lens hides its own shadows
  offset: new THREE.Vector3(0.32, -0.3, -0.05), aim: new THREE.Vector3(-0.05, -0.35, -6),
  inner: 0.15, outer: 0.42, spill: 0.9, // radians from the beam's axis: hotspot, edge of the beam, faint spill
  power: 14,
};
const LIGHT = {
  night: new dyno.DynoFloat({ value: 0 }),
  torch: new dyno.DynoFloat({ value: 0 }),
  pos: new dyno.DynoVec3({ value: new THREE.Vector3() }),
  dir: new dyno.DynoVec3({ value: new THREE.Vector3(0, 0, -1) }),
  shadowMatrix: new dyno.DynoMat4({ value: new THREE.Matrix4() }),
  shadowMap: new dyno.DynoSampler2D({ value: null }),
  moon: new dyno.DynoVec3({ value: new THREE.Vector3(0.02, 0.028, 0.05) }),
  // cos(edge), cos(hotspot), cos(spill), how much of the baked shading to flatten out (0 none, 1 all)
  cone: new dyno.DynoVec4({ value: new THREE.Vector4(Math.cos(TORCH.outer), Math.cos(TORCH.inner), Math.cos(TORCH.spill), 0.35) }),
  // shadows on (1) or off (0), base tolerance (m), extra tolerance per metre of distance, how far to nudge each
  // splat off its surface toward the torch before testing (m). The base is set per world from how closely its
  // collider sits on its splats: a hand-made collider can be 30 cm off, Marble's own about 3 cm.
  shadows: new dyno.DynoVec4({ value: new THREE.Vector4(1, 0.08, 0.02, 0.12) }),
  flash: new dyno.DynoVec4({ value: new THREE.Vector4(0, 0, 0, 0) }), // muzzle flash: position, brightness
};
// each world gets its own torch position/direction, shadow switch and flash: the world on the other side of a
// portal is lit by the torch carried through it, without shadows (the shadow map only has this world's collider)
function makeLightSet() {
  return {
    ...LIGHT,
    pos: new dyno.DynoVec3({ value: new THREE.Vector3() }),
    dir: new dyno.DynoVec3({ value: new THREE.Vector3(0, 0, -1) }),
    shadows: new dyno.DynoVec4({ value: LIGHT.shadows.value.clone() }),
    flash: new dyno.DynoVec4({ value: new THREE.Vector4() }),
  };
}
const LIGHT_GLSL = `
const vec2 LL_TAPS[5] = vec2[5](vec2(0.0), vec2(1.0, 0.0), vec2(-1.0, 0.0), vec2(0.0, 1.0), vec2(0.0, -1.0));
vec3 llRotate(vec4 q, vec3 v) { vec3 t = 2.0 * cross(q.xyz, v); return v + q.w * t + cross(q.xyz, t); }
vec3 llLight(vec3 c, vec3 s, vec4 q, vec3 rgb, float night, float torch, vec3 pos, vec3 dir,
             mat4 shadowMatrix, sampler2D shadowMap, vec4 shadows, vec3 moon, vec4 cone, vec4 flash) {
  vec3 base = pow(clamp(rgb, 0.0, 1.0), vec3(2.2));
  // the baked colour is surface colour times daylight; pulling every splat part-way toward mid-grey
  // brightness takes some of the baked sun and shade out before our own light goes on
  float lum = dot(base, vec3(0.2126, 0.7152, 0.0722));
  vec3 albedo = min(base * pow(0.18 / max(lum, 0.003), cone.w), vec3(1.0));
  // a flat splat's thinnest axis is the surface direction; round splats get a soft average instead
  vec3 ax; float smin, smid;
  if (s.x <= s.y && s.x <= s.z) { ax = vec3(1.0, 0.0, 0.0); smin = s.x; smid = min(s.y, s.z); }
  else if (s.y <= s.z) { ax = vec3(0.0, 1.0, 0.0); smin = s.y; smid = min(s.x, s.z); }
  else { ax = vec3(0.0, 0.0, 1.0); smin = s.z; smid = min(s.x, s.y); }
  vec3 n = llRotate(q, ax);
  float flatness = 1.0 - smoothstep(0.15, 0.6, smin / max(smid, 1e-7));
  vec3 L = pos - c;
  float d = length(L);
  L /= max(d, 1e-4);
  float ndl = dot(n, L);
  float facing = mix(0.6, abs(ndl), flatness);
  float cosA = dot(-L, dir);
  float beam = smoothstep(cone.x, cone.y, cosA) + 0.06 * smoothstep(cone.z, cone.x, cosA);
  float lit = torch * beam * facing / (d * d + 0.3);
  if (shadows.x > 0.5 && lit > 0.0) {
    // test a point nudged off the surface toward the torch, with more slack at grazing angles, so a surface
    // doesn't shadow itself where the collider sits a little above or below its splats
    vec3 off = normalize(mix(L, ndl < 0.0 ? -n : n, flatness));
    vec3 cs = c + off * shadows.w;
    float ds = length(pos - cs);
    float graze = clamp(sqrt(max(1.0 - ndl * ndl, 0.0)) / max(abs(ndl), 0.15), 0.0, 4.0) * flatness;
    vec4 sc = shadowMatrix * vec4(cs, 1.0);
    if (sc.w > 0.0) {
      vec2 uv = sc.xy / sc.w * 0.5 + 0.5;
      if (uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0) {
        // the map holds 1 / (1 + distance to the nearest collider surface); 0 means nothing in the way
        vec2 texel = 1.5 / vec2(textureSize(shadowMap, 0));
        float bias = shadows.y * (1.0 + 0.5 * graze) + shadows.z * ds, sum = 0.0;
        for (int k = 0; k < 5; k++) {
          float inv = textureLod(shadowMap, uv + LL_TAPS[k] * texel, 0.0).r;
          sum += (inv <= 0.0 || ds - bias <= 1.0 / inv - 1.0) ? 1.0 : 0.0;
        }
        lit *= sum / 5.0;
      }
    }
  }
  // the muzzle flash: a bare point of light for a frame or two, no shadows
  vec3 Lf = flash.xyz - c;
  float df2 = dot(Lf, Lf);
  float fl = flash.w * mix(0.6, abs(dot(n, Lf * inversesqrt(max(df2, 1e-6)))), flatness) / (df2 + 0.4);
  vec3 light = moon + vec3(1.0, 0.93, 0.84) * lit + vec3(1.0, 0.72, 0.42) * fl;
  return pow(mix(base, albedo * light, night), vec3(1.0 / 2.2));
}`;
const makeLightModifier = (L) => dyno.dynoBlock({ gsplat: dyno.Gsplat }, { gsplat: dyno.Gsplat }, ({ gsplat }) => {
  const d = new dyno.Dyno({
    inTypes: {
      gsplat: dyno.Gsplat, night: "float", torch: "float", pos: "vec3", dir: "vec3",
      shadowMatrix: "mat4", shadowMap: "sampler2D", shadows: "vec4", moon: "vec3", cone: "vec4", flash: "vec4",
    },
    outTypes: { gsplat: dyno.Gsplat },
    inputs: { gsplat, ...L },
    globals: () => [LIGHT_GLSL],
    statements: ({ inputs: i, outputs: o }) => [
      `${o.gsplat} = ${i.gsplat};`,
      `if (${i.night} > 0.0) {`,
      `  ${o.gsplat}.rgba.rgb = llLight(${i.gsplat}.center, ${i.gsplat}.scales, ${i.gsplat}.quaternion, ${i.gsplat}.rgba.rgb,`,
      `    ${i.night}, ${i.torch}, ${i.pos}, ${i.dir}, ${i.shadowMatrix}, ${i.shadowMap}, ${i.shadows}, ${i.moon}, ${i.cone}, ${i.flash});`,
      `}`,
    ],
  });
  return { gsplat: d.outputs.gsplat };
});

// the torch's shadow map: the collider drawn from the torch, storing 1 / (1 + distance)
const shadowRT = new THREE.WebGLRenderTarget(1024, 1024, { type: THREE.HalfFloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
LIGHT.shadowMap.value = shadowRT.texture;
const shadowCam = new THREE.PerspectiveCamera(THREE.MathUtils.radToDeg(2 * TORCH.spill) + 6, 1, 0.05, 120);
const shadowScene = new THREE.Scene();
const shadowMesh = new THREE.Mesh(undefined, new THREE.ShaderMaterial({
  uniforms: { origin: { value: new THREE.Vector3() } },
  vertexShader: `varying vec3 vW; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
  fragmentShader: `uniform vec3 origin; varying vec3 vW; void main() { gl_FragColor = vec4(1.0 / (1.0 + length(vW - origin))); }`,
  side: THREE.DoubleSide,
}));
shadowMesh.frustumCulled = false;
shadowMesh.visible = false;
shadowScene.add(shadowMesh);
// the same torch for the snares, which are ordinary meshes
const torchLamp = new THREE.SpotLight(0xffeed6, 0, 40, TORCH.outer, 0.65, 2);
torchLamp.position.copy(TORCH.offset);
torchLamp.target.position.copy(TORCH.aim);
camera.add(torchLamp, torchLamp.target);

const lights = { night: 0, nightTarget: URLQ.get("night") === "1" ? 1 : 0, torchOn: URLQ.get("night") === "1", torch: 0, saidDark: false, shadows: true };
function attachLights(w) {
  // order matters: knock the debris loose first, then light it where it ends up
  w.splat.worldModifiers = [makeDebrisModifier(), makeLightModifier(w.L)];
  w.splat.updateGenerator();
  w.L.shadows.value.y = THREE.MathUtils.clamp(1.2 * w.info.fit, 0.06, 0.45);
}
// switch which world you're standing in: physics, shadows, bullet hits and respawn all follow
function useWorld(i) {
  const w = worlds[i], showMesh = !!collider?.visible;
  if (collider) collider.visible = false;
  act = i;
  splatMesh = w.splat; collider = w.collider; worldInfo = w.info; hitGrid = w.grid;
  spawnAt.copy(w.spawn);
  if (collider) collider.visible = showMesh;
  shadowMesh.geometry = collider ? collider.geometry : new THREE.BufferGeometry();
  shadowMesh.visible = !!collider;
}
// is world w being drawn this frame? (the far world only while you're looking through the portal)
const drawn = (w) => w === worlds[act] || (portal.through && portal.ready);
const _tp = new THREE.Vector3(), _ta = new THREE.Vector3(), _td = new THREE.Vector3();
function updateLights(dt) {
  // lights going out take a couple of seconds, like a generator winding down; coming back is quicker
  const rate = lights.nightTarget > lights.night ? 0.45 : 1.2;
  lights.night = THREE.MathUtils.clamp(lights.night + Math.sign(lights.nightTarget - lights.night) * dt * rate, 0, 1);
  const night = lights.night * lights.night * (3 - 2 * lights.night);
  lights.torch += ((lights.torchOn ? 1 : 0) - lights.torch) * (1 - Math.exp(-dt * 30));
  lightK = 1 - night;
  scene.environmentIntensity = 1 - 0.96 * night;
  torchLamp.intensity = 60 * lights.torch * night;
  if (!splatMesh) return;
  const changed = night !== LIGHT.night.value || lights.torch !== LIGHT.torch.value;
  LIGHT.night.value = night;
  LIGHT.torch.value = lights.torch * TORCH.power;
  if (night <= 0 && !changed) return;
  // the torch rides on the camera rig, so its light and shadows move with every step and sway
  camera.updateMatrixWorld();
  camera.localToWorld(_tp.copy(TORCH.offset));
  camera.localToWorld(_ta.copy(TORCH.aim));
  _td.subVectors(_ta, _tp).normalize();
  for (const w of worlds) {
    const L = w.L;
    if (w === worlds[act]) {
      L.pos.value.copy(_tp); L.dir.value.copy(_td); L.shadows.value.x = lights.shadows ? 1 : 0;
    } else if (portal.ready) { // the torch shining through the portal, carried into the other world
      L.pos.value.copy(_tp).applyMatrix4(portal.T[act]); L.dir.value.copy(_td).transformDirection(portal.T[act]); L.shadows.value.x = 0;
    }
  }
  shadowMesh.material.uniforms.origin.value.copy(_tp);
  if (night > 0 && lights.torch > 0.01 && shadowMesh.visible && lights.shadows) {
    shadowCam.position.copy(_tp);
    shadowCam.lookAt(_ta);
    shadowCam.updateMatrixWorld();
    LIGHT.shadowMatrix.value.multiplyMatrices(shadowCam.projectionMatrix, shadowCam.matrixWorldInverse); // shared by both worlds' sets
    const clearAlpha = renderer.getClearAlpha();
    renderer.getClearColor(_clear);
    renderer.setRenderTarget(shadowRT);
    renderer.setClearColor(0x000000, 1);
    renderer.clear();
    renderer.render(shadowScene, shadowCam);
    renderer.setClearColor(_clear, clearAlpha);
  }
  // re-light the splats only when something changed: the torch is on (it moves with the camera) or a fade is running
  if (changed || (night > 0 && lights.torch > 0.01)) for (const w of worlds) if (drawn(w)) w.splat.needsUpdate = true;
}
const _clear = new THREE.Color();
function setNight(on) {
  lights.nightTarget = on ? 1 : 0;
  if (on && !lights.saidDark) {
    lights.saidDark = true;
    radio("Seven, Control. Lost the light out there? Your torch is on F.", "CONTROL");
  }
}
function setTorch(on) { lights.torchOn = on; sfx.click(); }

// ------------------------------------------------------------------ shoot the walls: splats knocked loose per shot
// Each shot records an impact (where, which way the surface faces, when). Every splat near it is decided by a
// hash of its own index: most of the centre flies off as chunks that arc, tumble and skid to a stop on the
// ground; some turns to a slow cloud of dust; the rest stays put as a dark, slightly sunken crater. Nothing is
// simulated frame to frame: each splat's position is worked out from the time since the shot, so it costs the
// same whether a shot was a second or a minute ago, and settled debris stays exactly where it fell.
const DEBRIS = { max: 32, radius: 0.42, depth: 0.18, fly: 0.85, cooldown: 0.16, live: 4 };
const debris = { count: 0, next: 0, last: -1, latest: -1e9, shots: 0 };
const DB = {
  now: new dyno.DynoFloat({ value: 0 }),
  count: new dyno.DynoFloat({ value: 0 }),
  // per impact: (point, time fired), (surface direction, radius), (ground height below, depth, share that flies, seed)
  a: new dyno.DynoUniform({ type: "vec4", count: DEBRIS.max, value: Array.from({ length: DEBRIS.max }, () => new THREE.Vector4(0, 0, 0, 1e9)) }),
  b: new dyno.DynoUniform({ type: "vec4", count: DEBRIS.max, value: Array.from({ length: DEBRIS.max }, () => new THREE.Vector4(0, 1, 0, 0)) }),
  c: new dyno.DynoUniform({ type: "vec4", count: DEBRIS.max, value: Array.from({ length: DEBRIS.max }, () => new THREE.Vector4()) }),
};
const DEBRIS_GLSL = `
uint dbHash(uint x) { x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16; return x; }
float dbRand(inout uint s) { s = dbHash(s); return float(s >> 8) * (1.0 / 16777216.0); }
vec4 dbQuatMul(vec4 a, vec4 b) { return vec4(a.w * b.xyz + b.w * a.xyz + cross(a.xyz, b.xyz), a.w * b.w - dot(a.xyz, b.xyz)); }
vec3 dbRot(vec4 q, vec3 v) { vec3 t = 2.0 * cross(q.xyz, v); return v + q.w * t + cross(q.xyz, t); }
void dbHit(inout vec3 c, inout vec3 s, inout vec4 q, inout vec4 rgba, int index, int k, float t, vec4 A, vec4 B, vec4 C, float u) {
  vec3 n = B.xyz;
  // splats are cut into small cells around the impact; a cell flies as one rigid chunk, so a piece of the real
  // surface (wood grain, plaster, book spines) comes off whole and tumbles, instead of a spray of specks
  float cs = 0.075;
  vec3 cell = floor((c - A.xyz) / cs);
  vec3 cc = A.xyz + (cell + 0.5) * cs;
  ivec3 ic = ivec3(cell) + 4096;
  uint cseed = dbHash(uint(ic.x) * 73856093u ^ uint(ic.y) * 19349663u ^ uint(ic.z) * 83492791u ^ uint(k) * 2654435761u ^ uint(C.w));
  float h1 = dbRand(cseed), h2 = dbRand(cseed), h3 = dbRand(cseed), h4 = dbRand(cseed), h5 = dbRand(cseed), h6 = dbRand(cseed);
  vec3 dc = cc - A.xyz;
  float uc = length(dc - n * dot(dc, n)) / B.w;
  uint sseed = dbHash(uint(index) * 9781u + uint(k) * 6271u + uint(C.w));
  float s1 = dbRand(sseed), s2 = dbRand(sseed), s3 = dbRand(sseed), s4 = dbRand(sseed);
  if (h1 < C.z * (1.0 - smoothstep(0.35, 1.0, uc))) {
    if (s1 < 0.12) {
      // dust: some of each chunk turns to powder that drifts out, rises a little, spreads and fades
      vec3 rnd = normalize(vec3(s2, s3, s4) * 2.0 - 1.0 + 1e-4);
      float e = 1.0 - exp(-t * 2.5);
      c += (n * 0.55 + rnd * 0.4 + vec3(0.0, 0.2, 0.0)) * e + vec3(0.0, 0.06, 0.0) * t;
      s *= mix(1.5, 4.0, smoothstep(0.0, 1.8, t));
      rgba.rgb = mix(rgba.rgb, vec3(0.62, 0.58, 0.52), 0.55);
      rgba.a *= 0.3 * (1.0 - smoothstep(0.3, 2.8, t));
      return;
    }
    // the chunk: thrown off the surface, falls under gravity, lands on the ground below the impact and skids
    vec3 rnd = normalize(vec3(h3, h4, h5) * 2.0 - 1.0 + 1e-4);
    vec3 v = (n * mix(0.8, 2.8, h6) + rnd * 1.1 + vec3(0.0, 0.8, 0.0)) * (1.0 - 0.4 * uc);
    float g = 9.8, h0 = max(cc.y - C.x, 0.0);
    float tl = (v.y + sqrt(v.y * v.y + 2.0 * g * h0)) / g;
    float tf = min(t, tl);
    vec3 p = cc + v * tf - vec3(0.0, 0.5 * g * tf * tf, 0.0);
    if (t > tl) {
      p += vec3(v.x, 0.0, v.z) * 0.14 * (1.0 - exp(-(t - tl) * 6.0));
      p.y = C.x + 0.03;
    }
    // it tumbles until it lands, turning about its own centre
    vec3 ax = normalize(vec3(h4, h6, h2) * 2.0 - 1.0 + 1e-4);
    float ang = tf * mix(4.0, 14.0, h2) + (t > tl ? h5 * 1.2 : 0.0);
    vec4 r = vec4(ax * sin(0.5 * ang), cos(0.5 * ang));
    c = p + dbRot(r, c - cc);
    q = dbQuatMul(r, q);
    return;
  }
  // left in the wall: scorched and pushed in a little, darkest at the centre
  float w = 1.0 - smoothstep(0.0, 1.0, u);
  rgba.rgb *= mix(1.0, 0.14, w * w);
  c -= n * (0.035 * w);
}`;
const makeDebrisModifier = () => dyno.dynoBlock({ gsplat: dyno.Gsplat }, { gsplat: dyno.Gsplat }, ({ gsplat }) => {
  const d = new dyno.Dyno({
    inTypes: { gsplat: dyno.Gsplat, now: "float", count: "float", a: "vec4", b: "vec4", c: "vec4" },
    outTypes: { gsplat: dyno.Gsplat },
    inputs: { gsplat, ...DB },
    globals: () => [DEBRIS_GLSL],
    statements: ({ inputs: i, outputs: o }) => [
      `${o.gsplat} = ${i.gsplat};`,
      `for (int k = 0; k < ${DEBRIS.max}; k++) {`,
      `  if (float(k) >= ${i.count}) break;`,
      `  vec4 A = ${i.a}[k];`,
      `  float t = ${i.now} - A.w;`,
      `  if (t < 0.0) continue;`,
      `  vec4 B = ${i.b}[k];`,
      `  vec4 C = ${i.c}[k];`,
      `  vec3 d = ${o.gsplat}.center - A.xyz;`,
      `  float dn = dot(d, B.xyz);`,
      `  if (abs(dn) > C.y) continue;`,
      `  float r = length(d - B.xyz * dn);`,
      `  if (r > B.w) continue;`,
      `  dbHit(${o.gsplat}.center, ${o.gsplat}.scales, ${o.gsplat}.quaternion, ${o.gsplat}.rgba, ${o.gsplat}.index, k, t, A, B, C, r / B.w);`,
      `}`,
    ],
  });
  return { gsplat: d.outputs.gsplat };
});
// Where a shot lands on the splats. Spark can raycast splats, but it checks every one (about 50 ms for 2M),
// which hitches the frame on every shot. Instead, once per world, the opaque splat centres go into a hash
// grid of 10 cm cells, and a shot walks only the cells along its path: well under a millisecond.
let hitGrid = null; // the grid of the world you're standing in
const hashCell = (x, y, z) => (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) >>> 0;
function buildHitGrid(mesh, info) {
  mesh.updateWorldMatrix(true, false);
  const e = mesh.matrixWorld.elements, sc = info.scale;
  const N = mesh.packedSplats?.numSplats ?? mesh.numSplats ?? 0;
  const pos = new Float32Array(N * 3), rad = new Float32Array(N);
  let n = 0;
  mesh.forEachSplat((i, c, s, q, o) => {
    if (o < 0.35) return; // haze and floaters don't stop bullets
    const k = n * 3;
    pos[k] = e[0] * c.x + e[4] * c.y + e[8] * c.z + e[12];
    pos[k + 1] = e[1] * c.x + e[5] * c.y + e[9] * c.z + e[13];
    pos[k + 2] = e[2] * c.x + e[6] * c.y + e[10] * c.z + e[14];
    rad[n] = Math.max(s.x, s.y, s.z) * sc;
    n++;
  });
  const bits = 21, mask = (1 << bits) - 1, inv = 1 / 0.1;
  const key = new Uint32Array(n), start = new Uint32Array(mask + 2);
  for (let i = 0; i < n; i++) {
    const k = hashCell(Math.floor(pos[i * 3] * inv), Math.floor(pos[i * 3 + 1] * inv), Math.floor(pos[i * 3 + 2] * inv)) & mask;
    key[i] = k; start[k + 1]++;
  }
  for (let k = 0; k <= mask; k++) start[k + 1] += start[k];
  const fill = start.slice(0, mask + 1), order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[fill[key[i]]++] = i;
  return { pos, rad, start, order, n, inv, mask };
}
function splatHit(ray, maxT, g = hitGrid) {
  if (!g) return null;
  const o = ray.origin, d = ray.direction, inv = g.inv, cell = 1 / inv;
  let ix = Math.floor(o.x * inv), iy = Math.floor(o.y * inv), iz = Math.floor(o.z * inv);
  const sx = d.x > 0 ? 1 : -1, sy = d.y > 0 ? 1 : -1, sz = d.z > 0 ? 1 : -1;
  const dX = Math.abs(cell / d.x), dY = Math.abs(cell / d.y), dZ = Math.abs(cell / d.z);
  let mX = d.x ? ((ix + (sx > 0 ? 1 : 0)) * cell - o.x) / d.x : Infinity;
  let mY = d.y ? ((iy + (sy > 0 ? 1 : 0)) * cell - o.y) / d.y : Infinity;
  let mZ = d.z ? ((iz + (sz > 0 ? 1 : 0)) * cell - o.z) / d.z : Infinity;
  let best = Infinity;
  for (let t = 0, guard = 0; t < maxT && guard < 4000; guard++) {
    const b = hashCell(ix, iy, iz) & g.mask;
    for (let j = g.start[b], end = g.start[b + 1]; j < end; j++) {
      const i = g.order[j], dx = g.pos[i * 3] - o.x, dy = g.pos[i * 3 + 1] - o.y, dz = g.pos[i * 3 + 2] - o.z;
      const tt = dx * d.x + dy * d.y + dz * d.z;
      if (tt <= 0.15 || tt >= best) continue;
      const r = Math.min(Math.max(g.rad[i], 0.015), 0.06);
      if (dx * dx + dy * dy + dz * dz - tt * tt < r * r) best = tt;
    }
    const next = Math.min(mX, mY, mZ);
    if (best <= next) break;
    if (mX === next) { ix += sx; mX += dX; } else if (mY === next) { iy += sy; mY += dY; } else { iz += sz; mZ += dZ; }
    t = next;
  }
  return best < maxT ? best : null;
}
function resetDebris() {
  debris.count = debris.next = 0; debris.shots = 0; debris.latest = -1e9;
  DB.count.value = 0;
  for (const v of DB.a.value) v.w = 1e9;
}
sfx.shot = () => {
  burst({ type: "lowpass", freq: 170, q: 0.6, gain: 1.4, attack: 0.001, decay: 0.22 }); // the thump
  burst({ freq: 2300, q: 0.5, gain: 1.1, attack: 0.001, decay: 0.09 }); // the crack, clipped by the body mic
  burst({ type: "highpass", freq: 700, q: 0.5, gain: 0.22, attack: 0.02, decay: 0.9, when: 0.02 }); // the space ringing
};
sfx.impact = (dist) => {
  const when = Math.min(0.4, dist / 343);
  burst({ freq: 1500, q: 0.8, gain: 0.5 / (1 + dist * 0.15), decay: 0.05, when });
  for (let i = 0; i < 7; i++) burst({ freq: 2200 + Math.random() * 3000, q: 1.5, gain: 0.12 / (1 + dist * 0.15), decay: 0.03, when: when + 0.25 + Math.random() * 0.6 });
};
const muzzle = new THREE.PointLight(0xffb36b, 0, 14, 2); // the flash on the snares (the splats get their own)
muzzle.position.set(0.25, -0.2, -0.5);
camera.add(muzzle);
const _shot = new THREE.Raycaster(), _rc = new THREE.Vector2(0, 0), _mz = new THREE.Vector3(), _fall = new THREE.Ray(), _shotB = new THREE.Ray();
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3();
let flashT = 0;
function fire() {
  if (mode !== "playing" || !worlds.length) return;
  if (clockT - debris.last < DEBRIS.cooldown) return;
  debris.last = clockT;
  debris.shots++;
  sfx.shot();
  flashT = 0.07;
  player.pitchT += 0.035 + Math.random() * 0.015; // recoil
  player.yawT += (Math.random() - 0.5) * 0.02;
  camera.updateMatrixWorld();
  _shot.setFromCamera(_rc, camera);
  _shot.far = 80;
  const t0 = performance.now();
  let ray = _shot.ray, w = worlds[act], travelled = 0;
  let hit = shotHit(w, ray);
  // a shot that goes into the portal before it hits anything here carries on in the other world
  const tP = portal.ready ? portalRayT(act, ray) : null;
  if (tP != null && (!hit || tP < hit.t)) {
    const T = portal.T[act];
    ray = _shotB.set(ray.at(tP + 0.02, _v1).applyMatrix4(T), _v2.copy(ray.direction).transformDirection(T));
    w = worlds[1 - act]; travelled = tP;
    hit = shotHit(w, ray);
  }
  debris.rayMs = performance.now() - t0;
  if (!hit) return;
  const { point, normal, groundY } = hit;
  const dist = travelled + hit.t;
  const k = debris.next;
  debris.next = (k + 1) % DEBRIS.max;
  debris.count = Math.min(DEBRIS.max, debris.count + 1);
  DB.a.value[k].set(point.x, point.y, point.z, clockT + dist / 900); // bullet flight
  DB.b.value[k].set(normal.x, normal.y, normal.z, DEBRIS.radius * (0.85 + Math.random() * 0.3));
  DB.c.value[k].set(Math.min(groundY, point.y), DEBRIS.depth, DEBRIS.fly, (Math.random() * 1e6) | 0);
  DB.count.value = debris.count;
  debris.latest = clockT;
  // the hit: a crack and a rattle of falling bits, later the further away it is
  sfx.impact(dist);
}
// where a ray hits world w: the splats say where, the collider says which way the surface faces and where the
// ground is for the chunks to land on
function shotHit(w, ray) {
  const col = w.collider;
  const cHit = col ? col.geometry.boundsTree.raycastFirst(ray, THREE.DoubleSide) : null;
  const sT = splatHit(ray, cHit ? cHit.distance + 0.6 : 60, w.grid);
  let t = null;
  if (sT != null) t = sT; else if (cHit) t = cHit.distance;
  if (t == null) return null;
  const point = ray.at(t, new THREE.Vector3());
  const normal = new THREE.Vector3();
  if (cHit && cHit.face && cHit.point.distanceTo(point) < 0.8) normal.copy(cHit.face.normal);
  else normal.copy(ray.direction).negate();
  if (normal.dot(ray.direction) > 0) normal.negate();
  // straight down from just off the surface (not from above, which finds ceilings)
  _fall.origin.copy(point).addScaledVector(normal, 0.3);
  _fall.direction.set(0, -1, 0);
  const ground = col ? col.geometry.boundsTree.raycastFirst(_fall, THREE.DoubleSide) : null;
  const groundY = ground && ground.distance < 12 ? ground.point.y : point.y - 1.2;
  return { t, point, normal, groundY };
}
function updateDebris(dt) {
  DB.now.value = clockT;
  flashT = Math.max(0, flashT - dt);
  const f = flashT > 0 ? 1 : 0;
  camera.localToWorld(_mz.copy(muzzle.position));
  for (const w of worlds) {
    if (w === worlds[act]) w.L.flash.value.set(_mz.x, _mz.y, _mz.z, f * 6);
    else if (portal.ready) { _v1.copy(_mz).applyMatrix4(portal.T[act]); w.L.flash.value.set(_v1.x, _v1.y, _v1.z, f * 6); }
  }
  muzzle.intensity = f * 40 * (lights.night > 0 ? 1 : 0.2);
  // regenerate the splats while anything is still moving (or a flash just changed the light)
  if (clockT - debris.latest < DEBRIS.live || f !== debris.lastFlash) for (const w of worlds) if (drawn(w)) w.splat.needsUpdate = true;
  debris.lastFlash = f;
}


// ------------------------------------------------------------------ portal hop: a hole in this world onto another
// A second generated world loads in the background, parked 400 m away. A disk-shaped portal stands a few metres
// from where you start, and its twin stands in the other world. While the portal is in view the frame is drawn in
// two passes: first the other world, from a virtual camera placed where you'd be standing relative to its twin and
// clipped to what lies beyond it; then this world on top, with a hole cut wherever you look through the disk.
// Each world is drawn only in its own pass, so the cost is the two worlds' splats, not twice both.
// Walking through the disk moves you, your torch and your physics into the other world.
const portal = {
  ready: false, armed: true, R: 1.05, through: false, hops: 0, name: null,
  T: [new THREE.Matrix4(), new THREE.Matrix4()], // [0]: from world 0 to world 1; [1]: back
  dyaw: [0, 0], rings: [],
};
const sparkBehind = new SparkRenderer({ renderer, accumExtSplats: RENDER.ext, lodSplatCount: RENDER.budget }); // sorts the far world for the virtual camera
const camera2 = new THREE.PerspectiveCamera();
const _m4 = new THREE.Matrix4(), _frustum = new THREE.Frustum(), _sph = new THREE.Sphere(), _pq = new THREE.Quaternion();
const _pc = new THREE.Vector3(), _pn = new THREE.Vector3(), _cw = new THREE.Vector3();
// the side of portal i you look and walk through: world 0's faces the start, world 1's faces its open ground
function portalFace(i, center, normal) {
  const o = worlds[i].portal;
  o.updateMatrixWorld(true);
  o.getWorldPosition(center);
  normal.set(0, 0, i === 0 ? 1 : -1).applyQuaternion(o.getWorldQuaternion(_pq));
}
function setDisk(cam, i, radius) {
  const u = spark.uniforms;
  u.diskRadius.value = radius;
  if (!radius) return;
  portalFace(i, _pc, _pn);
  cam.updateMatrixWorld(true);
  _m4.copy(cam.matrixWorld).invert();
  u.diskCenter.value.copy(_pc).applyMatrix4(_m4);
  u.diskNormal.value.copy(_pn).transformDirection(_m4);
  u.diskTwoSided.value = true;
}
// distance along a ray to where it passes through the front of portal i's disk, or null
function portalRayT(i, ray) {
  portalFace(i, _pc, _pn);
  const denom = ray.direction.dot(_pn);
  if (denom >= -1e-4) return null;
  const t = _v1.subVectors(_pc, ray.origin).dot(_pn) / denom;
  if (t <= 0) return null;
  ray.at(t, _v1).sub(_pc);
  return _v1.lengthSq() <= portal.R * portal.R ? t : null;
}
function renderWorld() {
  const here = worlds[act], there = portal.ready ? worlds[1 - act] : null;
  let through = false;
  if (there) {
    portalFace(act, _pc, _pn);
    camera.updateMatrixWorld();
    camera.getWorldPosition(_cw);
    const side = _v2.subVectors(_cw, _pc).dot(_pn);
    _frustum.setFromProjectionMatrix(_m4.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    through = side > 0 && _cw.distanceTo(_pc) < 80 && _frustum.intersectsSphere(_sph.set(_pc, portal.R));
  }
  portal.through = through;
  for (const w of worlds) {
    w.splat.visible = w === here;
    if (w.portal) w.portal.visible = w === here; // the twin is 400 m off in the other world: don't draw it here
  }
  world.visible = act === 0; // the snares live in the first world
  // the ring glows at a steady brightness on screen whatever the camera's exposure, with a slight shimmer
  const glow = (0.55 + 0.08 * Math.sin(clockT * 9) + 0.05 * Math.sin(clockT * 23.7)) / Math.max(exposure, 0.3);
  for (const r of portal.rings) r.material.color.setRGB(1.0 * glow, 0.78 * glow, 0.52 * glow);
  if (!through) {
    setDisk(camera, act, 0);
    spark.render(scene, camera);
    return;
  }
  // pass 1: the far world, seen from where this camera would be relative to the portal's twin
  camera2.projectionMatrix.copy(camera.projectionMatrix);
  camera2.projectionMatrixInverse.copy(camera.projectionMatrixInverse);
  camera2.near = camera.near; camera2.far = camera.far;
  _m4.multiplyMatrices(portal.T[act], camera.matrixWorld).decompose(camera2.position, camera2.quaternion, camera2.scale);
  camera2.updateMatrixWorld(true);
  here.splat.visible = false; there.splat.visible = true;
  const hide = [world, ...worlds.map((w) => w.collider).filter(Boolean), ...portal.rings], was = hide.map((o) => o.visible);
  for (const o of hide) o.visible = false;
  setDisk(camera2, 1 - act, portal.R); // keep only what's beyond the twin, seen through its disk
  // and only rasterise inside the disk's rectangle on screen: the far world is otherwise drawn full-screen and
  // thrown away everywhere but the disk
  const rt = renderer.getRenderTarget(), box = portalBox(rt);
  renderer.clear();
  if (box) { rt.scissor.copy(box); rt.scissorTest = true; renderer.setRenderTarget(rt); }
  renderer.autoClear = false;
  sparkBehind.render(scene, camera2);
  if (box) { rt.scissorTest = false; renderer.setRenderTarget(rt); }
  hide.forEach((o, k) => { o.visible = was[k]; });
  // pass 2: this world on top, with a hole wherever you look through the disk
  there.splat.visible = false; here.splat.visible = true;
  setDisk(camera, act, -portal.R);
  renderer.clearDepth();
  spark.render(scene, camera);
  renderer.autoClear = true;
}
// the on-screen rectangle (in target pixels) that portal disk act covers, or null if it can't be bounded
const _box = new THREE.Vector4(), _bq = new THREE.Quaternion(), _bx = new THREE.Vector3(), _by = new THREE.Vector3(), _bp = new THREE.Vector3();
function portalBox(rt) {
  if (!rt) return null;
  const o = worlds[act].portal;
  o.getWorldQuaternion(_bq);
  portalFace(act, _pc, _pn);
  _bx.set(1, 0, 0).applyQuaternion(_bq); _by.set(0, 1, 0).applyQuaternion(_bq);
  let x0 = 1, y0 = 1, x1 = -1, y1 = -1;
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * TAU, r = portal.R * 1.06;
    _bp.copy(_pc).addScaledVector(_bx, Math.cos(a) * r).addScaledVector(_by, Math.sin(a) * r);
    if (_v1.copy(_bp).applyMatrix4(camera.matrixWorldInverse).z > -camera.near) return null; // part of it is behind the lens
    _bp.project(camera);
    x0 = Math.min(x0, _bp.x); x1 = Math.max(x1, _bp.x); y0 = Math.min(y0, _bp.y); y1 = Math.max(y1, _bp.y);
  }
  x0 = Math.max(-1, x0); y0 = Math.max(-1, y0); x1 = Math.min(1, x1); y1 = Math.min(1, y1);
  if (x1 <= x0 || y1 <= y0) return null;
  const W = rt.width, H = rt.height, px = Math.floor((x0 * 0.5 + 0.5) * W) - 2, py = Math.floor((y0 * 0.5 + 0.5) * H) - 2;
  return _box.set(Math.max(0, px), Math.max(0, py), Math.min(W, Math.ceil((x1 - x0) * 0.5 * W) + 4), Math.min(H, Math.ceil((y1 - y0) * 0.5 * H) + 4));
}
// did the eye cross portal i's disk, front to back, between a and b?
function crossed(i, a, b) {
  portalFace(i, _pc, _pn);
  const da = _v1.subVectors(a, _pc).dot(_pn), db = _v2.subVectors(b, _pc).dot(_pn);
  if (!(da > 0 && db <= 0)) return false;
  _v1.lerpVectors(a, b, da / (da - db)).sub(_pc);
  _v1.addScaledVector(_pn, -_v1.dot(_pn));
  return _v1.lengthSq() <= portal.R * portal.R;
}
function hop() {
  const T = portal.T[act], dy = portal.dyaw[act], oldY = player.pos.y;
  player.pos.applyMatrix4(T);
  player.vel.applyAxisAngle(_up, dy);
  player.yaw += dy; player.yawT += dy; lastYaw += dy;
  player.eyeY += player.pos.y - oldY;
  useWorld(1 - act);
  // you arrive right on the far disk: step out 35 cm so a collision nudge can't send you straight back, and
  // don't re-arm the portal until you've cleared it
  portalFace(act, _pc, _pn);
  const sd = _v1.set(player.pos.x, player.pos.y + EYE, player.pos.z).sub(_pc).dot(_pn);
  if (sd < 0.35) player.pos.addScaledVector(_pn, 0.35 - sd);
  portal.armed = false;
  portal.hops++;
  burst({ type: "lowpass", freq: 300, q: 0.5, gain: 0.6, attack: 0.05, decay: 0.6 }); // a low rush of air
  burst({ type: "highpass", freq: 4000, q: 0.5, gain: 0.08, attack: 0.02, decay: 0.4, when: 0.05 });
  if (portal.hops === 1) radio("Seven, Control. Your GPS just jumped four hundred metres. Say again your position?", "CONTROL");
  if (portal.hops === 2) radio("Copy, you're back on the map. Don't do that again.", "CONTROL");
}
const _up = new THREE.Vector3(0, 1, 0);

// Where to stand a portal. Searches directions around a world's start point for open, level ground with room for
// the disk; "toward" prefers a direction (the way you face at the start), otherwise the most open one wins.
function portalSpot(w, feet, toward, dist) {
  const geo = w.collider.geometry, bvh = geo.boundsTree, ray = new THREE.Ray(), cp = {};
  const eye = feet.clone().add(new THREE.Vector3(0, 1.3, 0));
  let best = null;
  for (let k = 0; k < 32; k++) {
    const a = (k / 32) * TAU, dir = new THREE.Vector3(Math.sin(a), 0, Math.cos(a));
    // how far you can see that way: to the collider or to the first solid splats, whichever is nearer (plants,
    // furniture and clutter are often splats only, with nothing in the collider)
    let run = 30;
    for (const h of [1.3, 0.6]) {
      ray.set(eye.clone().setY(feet.y + h), dir);
      run = Math.min(run, bvh.raycastFirst(ray, THREE.DoubleSide)?.distance ?? 30, splatHit(ray, 30, w.grid) ?? 30);
    }
    for (const d of dist ? [dist, dist * 0.75, dist * 0.5] : [0.3, 0.8, 1.4]) {
      if (run < d + 1.2) continue;
      const c = feet.clone().addScaledVector(dir, d);
      ray.set(new THREE.Vector3(c.x, feet.y + 1.5, c.z), new THREE.Vector3(0, -1, 0));
      const g = bvh.raycastFirst(ray, THREE.DoubleSide);
      if (!g || Math.abs(g.point.y - feet.y) > 0.6) continue;
      c.y = g.point.y + portal.R + 0.03;
      // room for the disk: nothing within reach of its centre, top or sides
      const side = new THREE.Vector3(dir.z, 0, -dir.x);
      const probes = [c, c.clone().add(new THREE.Vector3(0, 0.7, 0)), c.clone().addScaledVector(side, 0.75), c.clone().addScaledVector(side, -0.75)];
      if (probes.some((p) => (bvh.closestPointToPoint(p, cp)?.distance ?? 9) < 0.3)) continue;
      const score = toward ? dir.dot(toward) * 10 + Math.min(run, 12) * 0.1 : run;
      if (!best || score > best.score) best = { score, center: c, dir };
      break;
    }
  }
  return best;
}
// the way with the longest clear view from a spot, at chest height (to the collider or the first solid splats)
function openDirection(w, feet) {
  const bvh = w.collider.geometry.boundsTree, ray = new THREE.Ray();
  let best = null, bestRun = 0;
  for (let k = 0; k < 32; k++) {
    const a = (k / 32) * TAU, dir = new THREE.Vector3(Math.sin(a), 0, Math.cos(a));
    ray.set(feet.clone().add(new THREE.Vector3(0, 1.2, 0)), dir);
    const run = Math.min(bvh.raycastFirst(ray, THREE.DoubleSide)?.distance ?? 30, splatHit(ray, 30, w.grid) ?? 30);
    if (run > bestRun) { bestRun = run; best = dir; }
  }
  return best;
}
function makeRing() {
  const ring = new THREE.Mesh(new THREE.TorusGeometry(portal.R, 0.022, 8, 96),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 1, 1), transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
  ring.renderOrder = 5;
  return ring;
}
async function openPortal(name, token, feetA, face) {
  const ex = PORTAL_WORLDS[name];
  if (!ex) { console.warn("No portal world called", name); return; }
  const W = { ...ex, scale: "auto", position: [400, 0, 0], flip: "auto", budget: RENDER.portalSplats[1] };
  const w = await loadWorld(W);
  if (token !== bootToken) { w.splat.dispose(); w.collider?.geometry.dispose(); return; }
  if (!w.collider) { w.splat.dispose(); return; }
  worldRootB.position.set(...w.position);
  worldRootB.scale.setScalar(w.info.scale);
  worldRootB.add(w.splat);
  w.splat.visible = false;
  w.collider.visible = false;
  scene.add(w.collider);
  const B = { W, splat: w.splat, collider: w.collider, info: w.info, L: makeLightSet(), spawn: new THREE.Vector3(...(w.info.spawn ?? w.position)), grid: null, portal: null };
  attachLights(B);
  B.grid = buildHitGrid(B.splat, B.info);
  // B's start point: straight down from the camera it was generated from (or a scan's chosen start)
  const down = B.collider.geometry.boundsTree.raycastFirst(new THREE.Ray(B.spawn.clone(), new THREE.Vector3(0, -1, 0)), THREE.DoubleSide);
  const feetB = down ? down.point.clone() : B.spawn.clone().add(new THREE.Vector3(0, -1.6, 0));
  const A = worlds[0];
  const a = portalSpot(A, feetA, face, 4.5), b = portalSpot(B, feetB, null, 0);
  if (!a || !b) { console.warn("No room for a portal", { a, b }); B.splat.parent.remove(B.splat); B.splat.dispose(); scene.remove(B.collider); return; }
  // world 0's portal faces back toward the start (+z), world 1's faces its open ground (-z)
  A.portal = new THREE.Object3D(); A.portal.position.copy(a.center); A.portal.lookAt(a.center.clone().sub(a.dir));
  B.portal = new THREE.Object3D(); B.portal.position.copy(b.center); B.portal.lookAt(b.center.clone().sub(b.dir));
  for (const o of [A.portal, B.portal]) { const r = makeRing(); o.add(r); portal.rings.push(r); scene.add(o); o.updateMatrixWorld(true); }
  worlds[1] = B;
  portal.T[0].copy(B.portal.matrixWorld).multiply(_m4.copy(A.portal.matrixWorld).invert());
  portal.T[1].copy(portal.T[0]).invert();
  for (const i of [0, 1]) { const e = new THREE.Euler().setFromRotationMatrix(portal.T[i], "YXZ"); portal.dyaw[i] = e.y; }
  portal.name = ex.label;
  portal.ready = true;
  if (mode === "playing") radio("Seven, Control. Thermal's showing something odd just ahead of you. Take a look.", "CONTROL");
  else $("status").textContent += ` A portal to the ${ex.label.split(",")[0].toLowerCase()} stands a few metres ahead.`;
}
function closePortal() {
  portal.ready = false; portal.through = false;
  for (const w of worlds) if (w.portal) { scene.remove(w.portal); w.portal = null; }
  for (const r of portal.rings) { r.geometry.dispose(); r.material.dispose(); }
  portal.rings.length = 0;
}

// ------------------------------------------------------------------ game state
const keys = {};
let mode = "loading"; // loading | ready | playing | paused | done
let gameT = 0, lastYaw = 0, cutProgress = 0, doneAt = 0, warnedFall = false;
const fwd = new THREE.Vector3(), right = new THREE.Vector3(), wish = new THREE.Vector3();
function bearingTo(x, z) { return (THREE.MathUtils.radToDeg(Math.atan2(x - player.pos.x, -(z - player.pos.z))) + 360) % 360; }
function heading() { return (THREE.MathUtils.radToDeg(-player.yaw) % 360 + 360) % 360; }
function nearestSnare() {
  let best = null, bd = Infinity;
  for (const s of snares) if (!s.cut) { const d = Math.hypot(s.x - player.pos.x, s.z - player.pos.z); if (d < bd) { bd = d; best = s; } }
  return best ? { s: best, d: bd } : null;
}
function targetSnare() {
  camera.getWorldDirection(fwd);
  for (const s of snares) {
    if (s.cut) continue;
    const dx = s.x - player.pos.x, dz = s.z - player.pos.z, d = Math.hypot(dx, dz);
    if (d > 2.0) continue;
    const look = Math.hypot(fwd.x, fwd.z) > 1e-3 ? (fwd.x * dx + fwd.z * dz) / (Math.hypot(fwd.x, fwd.z) * Math.max(d, 1e-3)) : 0;
    if (d < 0.9 || look > 0.75) return s;
  }
  return null;
}
function cut(s) {
  s.cut = true;
  for (const m of s.wire) m.visible = false;
  sfx.snip();
  const left = snares.filter((x) => !x.cut).length;
  if (left === 0) { radio("That's all five, seven. Good work. Come on back."); mode = "done"; doneAt = clockT + 6; }
  else radio(`Copy, ${snares.length - left} down. ${left} to go.`);
}

const _eyeA = new THREE.Vector3(), _eyeB = new THREE.Vector3();
function update(dt) {
  gameT += dt;
  _eyeA.set(player.pos.x, player.pos.y + EYE, player.pos.z);
  player.yaw += (player.yawT - player.yaw) * (1 - Math.exp(-dt * 13));
  player.pitch += (player.pitchT - player.pitch) * (1 - Math.exp(-dt * 11));
  const run = keys.ShiftLeft || keys.ShiftRight;
  const fz = (keys.KeyW || keys.ArrowUp ? 1 : 0) - (keys.KeyS || keys.ArrowDown ? 1 : 0);
  const fx = (keys.KeyD || keys.ArrowRight ? 1 : 0) - (keys.KeyA || keys.ArrowLeft ? 1 : 0);
  fwd.set(-Math.sin(player.yaw), 0, -Math.cos(player.yaw));
  right.set(Math.cos(player.yaw), 0, -Math.sin(player.yaw));
  wish.set(0, 0, 0).addScaledVector(fwd, fz).addScaledVector(right, fx);
  if (wish.lengthSq() > 1) wish.normalize();
  const speed = run && fz > 0 ? 3.3 : 1.45;
  const k = 1 - Math.exp(-dt * 7);
  player.vel.x += (wish.x * speed - player.vel.x) * k;
  player.vel.z += (wish.z * speed - player.vel.z) * k;
  player.vel.y += player.onGround ? -2 * dt : -18 * dt;
  // substeps keep the capsule from tunnelling through thin collider walls
  const sub = 4;
  for (let i = 0; i < sub; i++) {
    player.pos.addScaledVector(player.vel, dt / sub);
    if (collider) collide(dt / sub);
  }
  // walked through the portal?
  _eyeB.set(player.pos.x, player.pos.y + EYE, player.pos.z);
  if (portal.ready && !portal.armed) { portalFace(act, _pc, _pn); portal.armed = _v1.subVectors(_eyeB, _pc).dot(_pn) > 0.2 || _eyeB.distanceTo(_pc) > 2.5; }
  if (portal.ready && portal.armed && crossed(act, _eyeA, _eyeB)) hop();
  if (player.pos.y < spawnAt.y - 25) {
    player.pos.copy(spawnAt); player.vel.set(0, 0, 0);
    if (!warnedFall) { warnedFall = true; radio("Seven, you went off the edge of the map. Putting you back at the start.", "CONTROL", true); }
  }
  // the eye follows the capsule smoothly so stepping up a ledge doesn't snap the view
  player.eyeY += (player.pos.y + EYE - player.eyeY) * (1 - Math.exp(-dt * 14));
  const v = Math.hypot(player.vel.x, player.vel.z);
  const amp = smoothstep(0.1, 1.2, v) * (v > 2.2 ? 1.7 : 1) * (player.onGround ? 1 : 0.3);
  player.phase += dt * Math.PI * (v > 2.2 ? 2.7 : 1.85) * Math.min(1, v / 1.2);
  const step = Math.floor(player.phase / Math.PI);
  if (step !== player.steps) { player.steps = step; if (amp > 0.2) sfx.step(v > 2.2); }
  player.fatigue = Math.min(1, Math.max(0, player.fatigue + (v > 2.2 ? dt * 0.12 : -dt * 0.06)));
  const bob = -Math.abs(Math.sin(player.phase)) * 0.038 * amp;
  const sway = Math.sin(player.phase) * 0.022 * amp;
  const breathe = 0.003 + 0.01 * player.fatigue;
  const tt = gameT;
  camera.position.set(player.pos.x, player.eyeY + bob + Math.sin(tt * 1.6) * breathe * 0.5, player.pos.z).addScaledVector(right, sway);
  camera.rotation.set(
    player.pitch + Math.abs(Math.cos(player.phase)) * 0.01 * amp + Math.sin(tt * 1.6) * breathe + Math.sin(tt * 7.3) * 0.0012,
    player.yaw + Math.sin(player.phase) * 0.007 * amp + Math.sin(tt * 0.9) * 0.003,
    Math.sin(player.phase) * 0.014 * amp + Math.sin(tt * 1.1) * 0.002,
  );
  const s = targetSnare();
  if (s && keys.KeyE) { cutProgress = Math.min(1, cutProgress + dt / 1.1); if (cutProgress >= 1) { cut(s); cutProgress = 0; } }
  else cutProgress = Math.max(0, cutProgress - dt * 3);
  $("prompt").hidden = !s;
  $("promptFill").style.width = `${Math.round(cutProgress * 100)}%`;
  if (windGain) windGain.gain.setTargetAtTime(0.035 + 0.03 * (0.5 + 0.5 * Math.sin(tt * 0.37)) + v * 0.012, AC.currentTime, 0.4);
}

// ------------------------------------------------------------------ view toggles
function setUI(on) {
  VIEW.ui = on;
  view.classList.toggle("noui", !on);
}
function setClean(on) {
  VIEW.clean = on;
  camera.fov = on ? 70 : 84;
  camera.updateProjectionMatrix();
  resize(); // the clean camera renders at full resolution
}
setUI(VIEW.ui);

// ------------------------------------------------------------------ input
document.addEventListener("keydown", (e) => {
  keys[e.code] = true;
  if (e.repeat) return;
  if (e.code === "KeyV" && collider) collider.visible = !collider.visible;
  if (e.code === "KeyH") setUI(!VIEW.ui);
  if (e.code === "KeyC") setClean(!VIEW.clean);
  if (mode !== "playing") return;
  if (e.code === "KeyN") setNight(lights.nightTarget < 1);
  if (e.code === "KeyF") setTorch(!lights.torchOn);
  if (e.code === "Space") fire();
  if (e.code === "KeyQ" && act !== 0) { radio("No wires this side, seven. They're back through that thing you walked into.", "TRACKER", true); return; }
  if (e.code === "KeyQ") {
    const n = nearestSnare();
    if (n) radio(`Nearest wire: bearing ${pad(bearingTo(n.s.x, n.s.z), 3)}°, ${Math.round(n.d)} m. You're facing ${pad(heading(), 3)}°.`, "TRACKER", true);
  }
});
document.addEventListener("keyup", (e) => { keys[e.code] = false; });
window.addEventListener("blur", () => { for (const k in keys) keys[k] = false; });
let dragLook = false, dragging = false;
function lookBy(dx, dy) {
  player.yawT -= dx * 0.0022;
  player.pitchT = Math.max(-1.15, Math.min(0.9, player.pitchT - dy * 0.0022));
}
document.addEventListener("mousemove", (e) => {
  if (mode !== "playing") return;
  if (document.pointerLockElement === canvas || (dragLook && dragging)) lookBy(e.movementX, e.movementY);
});
canvas.addEventListener("mousedown", (e) => {
  dragging = true;
  if (mode !== "playing") return;
  if (document.pointerLockElement === canvas) { if (e.button === 0) fire(); return; }
  if (!dragLook) lockPointer();
});
window.addEventListener("mouseup", () => { dragging = false; });
function lockPointer() {
  try {
    const p = canvas.requestPointerLock();
    if (p && p.catch) p.catch(() => { dragLook = true; });
  } catch { dragLook = true; }
}
document.addEventListener("pointerlockerror", () => { dragLook = true; });
document.addEventListener("pointerlockchange", () => {
  if (document.pointerLockElement !== canvas && mode === "playing" && !dragLook) pause();
});
function pause() { mode = "paused"; showCard("Paused", "The footage keeps rolling. Click to carry on.", "Resume patrol"); }
function showCard(title, text, button, keysVisible = false) {
  $("cardTitle").textContent = title;
  $("cardText").textContent = text;
  $("cardKeys").hidden = !keysVisible;
  $("drop").hidden = true;
  $("status").textContent = "";
  $("go").textContent = button;
  $("go").disabled = false;
  $("screen").hidden = false;
}
function introCard() {
  $("cardTitle").textContent = "Last Light · AI world";
  const p = $("cardText"), name = document.createElement("b");
  name.id = "worldName";
  name.textContent = WORLD.label;
  p.textContent = "The same bodycam patrol, but in a world made by a generative model: ";
  p.append(name, ". Its daylight is baked into the splats; press N to put it out, F for your torch, and click to shoot lumps out of the walls. Find and cut the five snares.");
  $("cardKeys").hidden = false;
  $("drop").hidden = false;
  $("status").textContent = "Loading…";
  $("go").textContent = "Loading the world…";
  $("go").disabled = true;
  $("screen").hidden = false;
}
$("go").addEventListener("click", () => {
  if (mode === "done") { boot(WORLD); return; }
  if (mode !== "ready" && mode !== "paused") return;
  initAudio();
  const first = mode === "ready";
  mode = "playing";
  $("screen").hidden = true;
  lockPointer();
  if (first) {
    radio(WORLD.intro);
    radio("Your tracker has their positions. Press Q for a bearing to the nearest one.");
  }
});

// ------------------------------------------------------------------ your own world: drop its files on the page
const pendingFiles = { splat: null, collider: null, occJson: null, occPng: null };
const DROP_HINT = "Drop a Marble world's splats and collider (.spz + .glb) here, or a scan on its own (.spz, .ply, .splat).";
function takeFiles(list) {
  let zUp = false;
  for (const f of list) {
    const ext = f.name.toLowerCase().split(".").pop();
    if (/^(occupancy|structure|labels)\.(json|png)$|^3dgs_compressed\.ply$/i.test(f.name)) zUp = true; // InteriorGS
    if (/^occupancy\.json$/i.test(f.name)) pendingFiles.occJson = f;
    else if (/^occupancy\.png$/i.test(f.name)) pendingFiles.occPng = f;
    else if (["spz", "ply", "splat", "ksplat", "sog"].includes(ext)) pendingFiles.splat = f;
    else if (ext === "glb") pendingFiles.collider = f;
  }
  const { splat, collider: col } = pendingFiles;
  if (splat) {
    pendingFiles.splat = pendingFiles.collider = null;
    $("dropText").textContent = DROP_HINT;
    // no collider dropped with it? then it's a scan: collision is built from the splats, at life size
    boot({
      label: splat.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " "),
      splat, collider: col, scale: col ? "auto" : +(URLQ.get("scale") ?? 1), position: [0, 0, 0], spawn: null, flip: URL_FLIP, intro: OWN_INTRO,
      up: zUp ? "z" : URLQ.get("up") || "y",
      occupancy: pendingFiles.occJson && pendingFiles.occPng ? { json: pendingFiles.occJson, png: pendingFiles.occPng } : null,
    });
    pendingFiles.occJson = pendingFiles.occPng = null;
    return;
  }
  $("dropText").textContent = col ? `Got ${col.name}. Now its splats (.spz).`
    : "Those aren't world files. It needs the splats (.spz) and the collider mesh (.glb).";
}
$("pick").addEventListener("change", (e) => { takeFiles(e.target.files); e.target.value = ""; });
window.addEventListener("dragover", (e) => { e.preventDefault(); $("drop").classList.add("over"); });
window.addEventListener("dragleave", (e) => { if (!e.relatedTarget) $("drop").classList.remove("over"); });
window.addEventListener("drop", (e) => {
  e.preventDefault();
  $("drop").classList.remove("over");
  if (e.dataTransfer?.files?.length) takeFiles(e.dataTransfer.files);
});

// ------------------------------------------------------------------ loop
let last = performance.now();
function step(dt) {
  clockT += dt;
  if (mode === "playing" || mode === "done") update(dt);
  if (mode === "done" && clockT > doneAt && $("screen").hidden) {
    if (document.pointerLockElement) document.exitPointerLock();
    const mins = Math.floor(gameT / 60), secs = Math.floor(gameT % 60);
    showCard("Patrol complete", `All ${snares.length} wires cut in ${mins}:${pad(secs)}.`, "Patrol again");
  }
  if (mode !== "loading") {
    const turn = Math.abs(player.yaw - lastYaw) / Math.max(dt, 1e-3);
    lastYaw = player.yaw;
    const v = Math.hypot(player.vel.x, player.vel.z);
    updateDebris(dt);
    updateLights(dt);
    renderFootage(dt, Math.min(0.55, 0.14 + turn * 0.09 + v * 0.02), Math.min(1, 0.2 + turn * 0.35 + v * 0.06));
    updateOSD(gameT, heading());
    $("torchState").textContent = lights.nightTarget > 0 || lights.night > 0 ? (lights.torchOn ? "TORCH ON" : "TORCH OFF") : "DAYLIGHT BAKED IN";
    updateRadio();
  } else {
    renderer.setRenderTarget(null);
    renderer.clear();
  }
}
renderer.setAnimationLoop((now) => {
  const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
  last = now;
  step(dt);
});

// ------------------------------------------------------------------ boot
let bootToken = 0;
function boot(W) { loadAndStart(W).catch(bootFailed); }
async function loadAndStart(W) {
  const token = ++bootToken;
  WORLD = W;
  mode = "loading";
  if (document.pointerLockElement) document.exitPointerLock();
  introCard();
  unloadWorld();
  for (const k in keys) keys[k] = false;
  gameT = 0; cutProgress = 0; warnedFall = false;
  const progress = setInterval(() => {
    const { loaded, total } = splatBytes;
    if (loaded) $("status").textContent = `Loading the generated world: ${(loaded / 1e6).toFixed(0)}${total ? ` / ${(total / 1e6).toFixed(0)}` : ""} MB`;
  }, 250);
  let w;
  try {
    if (W.splat instanceof File) $("status").textContent = `Reading ${W.splat.name} (${(W.splat.size / 1e6).toFixed(0)} MB)…`;
    w = await loadWorld({ ...W, budget: W.portal ? RENDER.portalSplats[0] : RENDER.splats });
  } finally { clearInterval(progress); }
  if (token !== bootToken) { w.splat.dispose(); w.collider?.geometry.dispose(); return; } // a newer world was dropped meanwhile
  worldRoot.position.set(...w.position);
  worldRoot.scale.setScalar(w.info.scale);
  worldRoot.add(w.splat);
  if (w.collider) scene.add(w.collider);
  const A = { W, splat: w.splat, collider: w.collider, info: w.info, L: LIGHT, spawn: new THREE.Vector3(...(W.spawn ?? w.info.spawn ?? [0, 0, 0])), grid: null, portal: null };
  worlds.push(A);
  attachLights(A);
  resetDebris();
  useWorld(0);
  // level of detail is built in a worker after the world is up; Spark switches to it when it's ready
  if (RENDER.lod && splatMesh.createLodSplats) {
    const mesh = splatMesh, t = performance.now();
    mesh.createLodSplats().then(() => { if (mesh === splatMesh) debris.lodMs = Math.round(performance.now() - t); })
      .catch((err) => console.warn("No level of detail:", err));
  }
  $("status").textContent = "Indexing the splats for bullet hits…";
  await new Promise((r) => setTimeout(r, 0));
  const tg = performance.now();
  A.grid = hitGrid = buildHitGrid(A.splat, A.info);
  debris.gridMs = Math.round(performance.now() - tg);
  // settle the capsule onto the ground under the spawn point (by default the world's own camera position)
  player.pos.copy(spawnAt);
  player.vel.set(0, 0, 0);
  player.yaw = player.yawT = Math.PI; player.pitch = player.pitchT = -0.05;
  for (let i = 0; i < 90; i++) { player.vel.y += -18 / 60; player.pos.addScaledVector(player.vel, 1 / 60); if (collider) collide(1 / 60); }
  player.vel.set(0, 0, 0);
  player.eyeY = player.pos.y + EYE;
  // a scan has no "camera it was made from" to face along: face the most open way instead
  if (w.info.derived) {
    const d = openDirection(A, player.pos);
    if (d) player.yaw = player.yawT = Math.atan2(-d.x, -d.z);
  }
  update(0.016);
  gameT = 0;
  if (collider) placeSnares();
  try { await lightSnares(); } catch (err) { console.warn("Env capture failed:", err); }
  if (token !== bootToken) return;
  const n = splatMesh.numSplats ?? splatMesh.packedSplats?.numSplats ?? 0;
  const across = collider ? Math.round(2 * walkableRadius() / 5) * 5 : 0;
  $("status").textContent = !collider
    ? `Loaded ${fmtM(n)} splats, but there's no collider mesh, so there's nothing to walk on.`
    : `Ready. ${fmtM(n)} splats${worldInfo.dropped ? ` (the faintest ${fmtM(worldInfo.dropped)} of ${fmtM(worldInfo.loaded)} dropped for frame rate)` : ""}, about ${across} m across, ${snares.length} snares hidden.`
      + (worldInfo.derived ? ` No collision mesh came with it, so one was built from the splats (${fmtM(worldInfo.tris)} triangles${worldInfo.levelled ? `, scan levelled by ${worldInfo.levelled.toFixed(1)}°` : ""}).` : "");
  $("go").textContent = "Start patrol";
  $("go").disabled = !collider;
  mode = collider ? "ready" : "loading";
  if (collider && W.portal) openPortal(W.portal, token, player.pos.clone(), new THREE.Vector3(-Math.sin(player.yaw), 0, -Math.cos(player.yaw))).catch((err) => console.warn("Portal failed:", err));
}
function bootFailed(err) {
  console.error(err);
  $("status").textContent = `Something failed while loading: ${err.message || err}`;
}
boot(WORLD);

window.game = {
  THREE, renderer, scene, camera, player, keys, snares, worldRoot, spark,
  get collider() { return collider; }, get world() { return WORLD; }, get info() { return worldInfo; },
  get mode() { return mode; }, set mode(v) { mode = v; }, get exposure() { return exposure; },
  step, lookBy, cut, radio, groundAt, boot, takeFiles,
  lights, LIGHT, TORCH, setNight, setTorch, shadowRT, fire, DEBRIS, debris, splatHit,
  RENDER, hdrRT, get splatMesh() { return splatMesh; },
  worlds, portal, get act() { return act; }, useWorld, renderWorld, camera2,
  VIEW, setUI, setClean,
};
</script>
</body>
</html>
