
// ================================================================== Last Light
// A ranger's chest-mounted bodycam on a dusk patrol. Rendered in realtime (no path tracing); the
// footage look (wide fisheye, sway, smear, slow auto exposure, sensor noise, compression) carries the realism.

// ------------------------------------------------------------------ renderer, scene, camera
const view = $("view");
const canvas = $("c");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
renderer.setPixelRatio(1); // bodycam footage is soft anyway; CSS pixels keep the frame rate up
renderer.toneMapping = THREE.NoToneMapping; // the develop pass tone maps
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
const maxAniso = renderer.capabilities.getMaxAnisotropy();

const scene = new THREE.Scene();
const world = new THREE.Group();
scene.add(world);

const EYE = 1.36; // chest height
const camera = new THREE.PerspectiveCamera(84, 1, 0.05, 2000); // rendered wide, bent into a fisheye later
camera.rotation.order = "YXZ";
scene.add(camera);

const sun = new THREE.DirectionalLight(0xffffff, 0);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -20, right: 20, top: 20, bottom: -20, near: 1, far: 260 });
sun.shadow.bias = -0.0003;
sun.shadow.normalBias = 0.04;
sun.shadow.radius = 2;
scene.add(sun, sun.target);

// handheld torch, a little right of and below the lens so its shadows are visible
const TORCH_CD = 45;
const torch = new THREE.SpotLight(0xfff0dc, 0, 45, 0.42, 0.65, 2);
torch.castShadow = true;
torch.shadow.mapSize.set(512, 512);
torch.shadow.bias = -0.0006;
torch.shadow.normalBias = 0.02;
torch.shadow.camera.near = 0.15;
torch.shadow.autoUpdate = false; // only redraw its shadow map while it's on...
torch.shadow.needsUpdate = true; // ...but draw it once now: a never-allocated shadow map makes every lit draw fail
torch.position.set(0.16, -0.22, -0.05);
torch.target.position.set(-0.05, -0.35, -6);
camera.add(torch, torch.target);

// ------------------------------------------------------------------ ground for walking on
// The path traced page only needed detail near one viewpoint. Here you can walk anywhere inside ~30 m,
// so the close-up rocky scan covers a uniform 76 m grid, and the aerial scan ring takes over beyond it.
function soilColor(x, z, out, i, alpha) {
  const b = Math.min(1.25, Math.max(0.6, 1 + 0.26 * fbm(x * 0.18 + 3.1, z * 0.18 - 7.7, 3, 41) + 0.1 * fbm(x * 0.9, z * 0.9, 2, 57)));
  const warm = 0.08 * fbm(x * 0.08, z * 0.08, 2, 77);
  out[i * 4] = b * (1 + warm); out[i * 4 + 1] = b; out[i * 4 + 2] = b * (1 - warm); out[i * 4 + 3] = alpha;
}
function gridGround(tex, tint) {
  const T = TERRAIN, S = 2 * T.nearEnd, SEG = 600, half = S / 2, step = S / SEG, n = SEG + 1;
  const pos = new Float32Array(n * n * 3), uv = new Float32Array(n * n * 2), col = new Float32Array(n * n * 4);
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const i = iz * n + ix, x = -half + ix * step, z = -half + iz * step, r = Math.hypot(x, z);
      const [u, v] = groundUV(x, z);
      pos[i * 3] = x; pos[i * 3 + 1] = macroHeight(x, z) + dispAmp(r) * (dispAt(u, v) - 0.5); pos[i * 3 + 2] = z;
      uv[i * 2] = u; uv[i * 2 + 1] = v;
      soilColor(x, z, col, i, 1 - smoothstep(T.nearFade, T.nearEnd, r));
    }
  }
  const index = new Uint32Array(SEG * SEG * 6);
  let t = 0;
  for (let iz = 0; iz < SEG; iz++) {
    for (let ix = 0; ix < SEG; ix++) {
      const a = iz * n + ix, b = a + 1, c = a + n, d = c + 1;
      index[t++] = a; index[t++] = c; index[t++] = b;
      index[t++] = b; index[t++] = c; index[t++] = d;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 4));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({
    map: tex.diff, normalMap: tex.nor, roughnessMap: tex.arm, aoMap: tex.arm,
    roughness: 1, metalness: 0, vertexColors: true, transparent: true,
  });
  mat.color.copy(tint);
  softenPointSun(mat);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "ground";
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  return mesh;
}
function buildGameGround(tex) {
  H0 = rawHeight(0, 0);
  const T = TERRAIN;
  const tintFor = (avg) => new THREE.Color(SOIL.r / avg.r, SOIL.g / avg.g, SOIL.b / avg.b);
  const near = gridGround(tex.near, tintFor(tex.near.avg));
  const far = groundMesh({
    r0: T.farStart, R: T.R, fan: false, tile: FAR_TILE, angle: -0.7, displace: false, tex: tex.far, tint: tintFor(tex.far.avg),
    offset: (r) => -0.03 * (1 - smoothstep(T.nearEnd - 1, T.nearEnd + 0.5, r)),
    alpha: (r) => 1 - smoothstep(T.farFade, T.R * 0.97, r),
  });
  far.renderOrder = -1;
  return [far, near];
}

// ------------------------------------------------------------------ layout for a walkable area
const solids = []; // circles the player can't walk through
const bushSpots = []; // where snares can be set
let onPlace = (id, wrap, size, scale, x, z) => {
  const w = Math.max(size.x, size.z) * scale;
  if (/boulder_0|cliff/.test(id)) solids.push({ x, z, r: 0.42 * w });
  else if (/quiver_tree/.test(id)) solids.push({ x, z, r: 0.2 * scale });
  else if (/othonna/.test(id) && size.y * scale > 1.1) solids.push({ x, z, r: 0.28 * w });
  if (/rooibos|othonna/.test(id)) bushSpots.push({ x, z, r: 0.5 * w });
};
const PLAY_R = 30;
function buildGameLayout() {
  rand = mulberry32(20261120);
  const trees = [
    ["quiver_tree_01", HERO.x, HERO.z, 0.6, 1.55], ["quiver_tree_02", 5.4, -15.5, 2.1, 1.75], ["quiver_tree_02", -9.5, -22, 4.0, 2.2],
    ["quiver_tree_01", 15, -21, 2.7, 1.5], ["quiver_tree_01", 13, 9, 1.3, 1.35], ["quiver_tree_02", -15, 5, 5.2, 2.0],
    ["quiver_tree_01", -5, 18, 3.9, 1.7], ["quiver_tree_02", 8, 22, 0.8, 1.9],
  ];
  for (const [id, x, z, rot, scale] of trees) place(id, 0, x, z, { rot, scale, sink: 0.01, tilt: 0, claim: 0.8 });
  const rocks = [
    ["namaqualand_boulder_04", -4.3, -9.8, 1.2, 1.0, 0.16], ["namaqualand_boulder_03", 3.7, -11.2, 2.4, 1.0, 0.14],
    ["namaqualand_boulder_02", 1.9, -5.2, 0.3, 1.0, 0.14], ["namaqualand_boulder_05", -2.5, -3.7, 2.0, 1.0, 0.18],
    ["namaqualand_boulder_06", 3.0, -2.9, 0.9, 1.0, 0.18], ["namaqualand_boulder_03", -7.2, -16.5, 5.0, 1.5, 0.15],
    ["namaqualand_boulder_04", 8.5, -19, 3.1, 1.6, 0.15], ["namaqualand_boulder_02", -0.8, -12.5, 4.4, 1.3, 0.14],
    ["namaqualand_boulder_04", 9.5, 2.5, 4.0, 1.2, 0.16], ["namaqualand_boulder_03", -10.5, -5.5, 1.9, 1.1, 0.15],
    ["namaqualand_boulder_02", -6.5, 9.5, 2.8, 1.2, 0.14], ["namaqualand_boulder_05", 4.5, 12.5, 0.7, 1.3, 0.18],
    ["namaqualand_boulder_06", 12.5, -8, 5.5, 1.4, 0.18], ["namaqualand_boulder_03", -17, -12, 3.3, 1.4, 0.15],
    ["namaqualand_boulder_04", 18, 15, 0.2, 1.5, 0.15], ["namaqualand_boulder_02", -14, 16, 1.6, 1.4, 0.14],
  ];
  const rockSpots = [];
  for (const [id, x, z, rot, scale, sink] of rocks) {
    if (place(id, 0, x, z, { rot, scale, sink, tilt: 0.4 })) {
      const v = LIB[id][0];
      rockSpots.push({ x, z, r: 0.5 * Math.max(v.size.x, v.size.z) * scale });
    }
  }
  // outcrops just past the patrol edge, and a ring of boulders that hides where the scans meet the photo
  const cliffs = [[-15, -30, 0.4, 1.9], [17, -34, 3.6, 1.6], [33, 6, 2.2, 1.8], [-33, 12, 5.1, 1.7], [4, 36, 1.0, 2.0], [-26, -24, 2.9, 1.5]];
  for (const [x, z, rot, scale] of cliffs) place("namaqualand_cliff_01", 0, x, z, { rot, scale, sink: 0.15, tilt: 0.2 });
  const ring = ["namaqualand_boulder_03", "namaqualand_boulder_04", "namaqualand_boulder_03", "namaqualand_boulder_04", "namaqualand_boulder_05"];
  for (let i = 0; i < 13; i++) scatter(ring[i % ring.length], 1, { rMin: 25, rMax: 35, sink: 0.18, tilt: 0.3, scale: [1.0, 1.9], behind: 1 });
  scatter("namaqualand_boulders_01", 14, { around: rockSpots, sink: 0.2, tilt: 0.7, scale: [0.7, 1.3] });
  scatter("namaqualand_rocks_01", 12, { around: rockSpots, sink: 0.25, tilt: 0.8, scale: [0.8, 1.4] });
  scatter("namaqualand_stones_01", 18, { rMin: 1.2, rMax: 28, sink: 0.25, tilt: 0.9, scale: [0.9, 1.6] });
  scatter("othonna_cerarioides", 45, { rMin: 3, rMax: 36, sink: 0.02, tilt: 0.2, scale: [0.8, 1.25] });
  scatter("wild_rooibos_bush", 380, { rMin: 1.5, rMax: 36, sink: 0.03, tilt: 0.3, scale: [0.9, 1.8] });
  scatter("cheiridopsis_succulent", 14, { around: rockSpots, sink: 0.05, tilt: 0.7 });
  scatter("crystalline_iceplant", 26, { around: rockSpots, sink: 0.02, tilt: 0.8, scale: [0.9, 1.6] });
  const patches = (x, z) => smoothstep(-0.12, 0.35, fbm(x * 0.21 + 5, z * 0.21 - 3, 3, 91));
  scatter("flower_gazania", 260, { rMin: 1.2, rMax: 28, mask: patches, sink: 0.02, tilt: 0.5, scale: [0.85, 1.25] });
  scatter("flower_ursinia", 60, { rMin: 1.2, rMax: 26, mask: patches, sink: 0.02, tilt: 0.5 });
  scatter("flower_empodium", 100, { rMin: 1.2, rMax: 26, mask: (x, z) => 0.3 + 0.7 * patches(x + 9, z - 4), sink: 0.02, tilt: 0.4 });
  // small plants and pebbles don't need to cast shadows; skipping them halves the shadow pass
  world.traverse((o) => {
    if (!o.isMesh) return;
    const name = [].concat(o.material)[0].name;
    if (/flower|iceplant|cheiridopsis|stones|rocks_02/.test(name)) o.castShadow = false;
  });
}

// ------------------------------------------------------------------ snares
const wireMat = new THREE.MeshStandardMaterial({ color: 0xb4b4ad, metalness: 0.95, roughness: 0.28 });
const stakeMat = new THREE.MeshStandardMaterial({ color: 0xb59a74, roughness: 0.9 }); // freshly cut, paler than the dead wood around it
const ragMat = new THREE.MeshStandardMaterial({ color: 0x3f6f9c, roughness: 0.75, side: THREE.DoubleSide }); // poachers tag snares with plastic scraps to find them again
function makeSnare() {
  const g = new THREE.Group();
  const stake = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.02, 0.62, 6), stakeMat);
  stake.position.set(0, 0.27, 0);
  stake.rotation.z = 0.14;
  const loopPts = [];
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * TAU;
    loopPts.push(new THREE.Vector3(0.34 + Math.cos(a) * 0.1 * (1 + 0.06 * Math.sin(a * 3)), 0.14 + Math.sin(a) * 0.11, 0.01 * Math.sin(a * 2)));
  }
  const loop = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(loopPts, true), 96, 0.0038, 5, true), wireMat);
  const lead = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([
    new THREE.Vector3(0.02, 0.36, 0), new THREE.Vector3(0.12, 0.3, 0.01), new THREE.Vector3(0.21, 0.2, 0), new THREE.Vector3(0.245, 0.14, 0),
  ]), 24, 0.0038, 5, false), wireMat);
  const ragGeo = new THREE.PlaneGeometry(0.05, 0.16, 1, 4);
  const rp = ragGeo.attributes.position;
  for (let i = 0; i < rp.count; i++) rp.setZ(i, 0.02 * Math.sin(rp.getY(i) * 30));
  ragGeo.translate(0, -0.08, 0);
  const rag = new THREE.Mesh(ragGeo, ragMat);
  rag.position.set(0.05, 0.55, 0);
  rag.rotation.set(0.2, 0.6, -0.35);
  for (const m of [stake, loop, lead, rag]) { m.castShadow = true; m.receiveShadow = true; }
  g.add(stake, loop, lead, rag);
  return { group: g, wire: [loop, lead] };
}
const snares = [];
function placeSnares() {
  const r = mulberry32(5150);
  const cands = bushSpots.filter((b) => { const d = Math.hypot(b.x, b.z); return d > 7 && d < 26; });
  for (let i = cands.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [cands[i], cands[j]] = [cands[j], cands[i]]; }
  for (const b of cands) {
    if (snares.length === 5) break;
    if (snares.some((s) => Math.hypot(s.x - b.x, s.z - b.z) < 9)) continue;
    const a = r() * TAU;
    const x = b.x + Math.cos(a) * (b.r + 0.3), z = b.z + Math.sin(a) * (b.r + 0.3);
    if (solids.some((s) => Math.hypot(s.x - x, s.z - z) < s.r + 0.4)) continue;
    const s = makeSnare();
    s.group.position.set(x, heightAt(x, z) - 0.02, z);
    s.group.rotation.y = a + Math.PI / 2;
    world.add(s.group);
    snares.push({ n: snares.length + 1, x, z, cut: false, ...s });
  }
}

// ------------------------------------------------------------------ sky and dusk
let sunDir = new THREE.Vector3(0, 1, 0);
let nightSky = null;
let lightK = 1;
const DUSK_SECONDS = 360; // real seconds from low sun to blue hour
const duskTint = new THREE.Color(1.0, 0.42, 0.2);
function setupSky() {
  scene.background = sky.full;
  scene.environment = sky.clipped;
  const { theta, dir } = sunDirection();
  scene.backgroundRotation.set(0, theta, 0);
  scene.environmentRotation.set(0, theta, 0);
  sunDir = dir;
}
function applyLighting(gameT) {
  const k = 1 - smoothstep(0, 1, Math.min(1, gameT / DUSK_SECONDS)); // 1 at start, 0 at dusk
  lightK = k;
  const sunK = Math.pow(k, 2.5);
  const skyK = 0.05 + 0.95 * Math.pow(k, 1.6);
  scene.environmentIntensity = skyK;
  // The photo can't set, so once the light is going the backdrop swaps to the copy with the sun cut out
  // and dims faster than the light does; otherwise the boosted night exposure shows a daytime sky.
  // Late in the dusk it switches to the overcast photo from the same hilltop: same skyline, no sun or lens star.
  scene.background = k > 0.5 ? sky.full : k > 0.25 || !nightSky ? sky.clipped : nightSky.full;
  scene.backgroundIntensity = 0.012 + 0.988 * Math.pow(k, 2.4);
  sun.intensity = sky.hasSun ? sky.sunIrradiance * sunK : 0;
  sun.shadow.autoUpdate = sunK > 0.02; // stop redrawing the sun's shadow map once there's no sun
  sun.color.copy(sky.sunColor).lerp(duskTint, (1 - k) * 0.7);
  return k;
}

// ------------------------------------------------------------------ footage pipeline
const fsq = new FullScreenQuad(null);
const quadVS = /* glsl */`varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const hdrRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
const BLOOM_LEVELS = 6;
const bloomRT = Array.from({ length: BLOOM_LEVELS }, () => new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false }));
const ldrRT = [0, 1].map(() => new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false }));
const lumRT = new THREE.WebGLRenderTarget(64, 36, { type: THREE.FloatType, depthBuffer: false });

const prefilterMat = new THREE.ShaderMaterial({
  uniforms: { tSrc: { value: null }, texel: { value: new THREE.Vector2() }, exposure: { value: 1 }, threshold: { value: 2.6 }, knee: { value: 1.0 }, clampMax: { value: 10 } },
  vertexShader: quadVS,
  fragmentShader: /* glsl */`
    uniform sampler2D tSrc; uniform vec2 texel; uniform float exposure, threshold, knee, clampMax;
    varying vec2 vUv;
    vec3 tap(vec2 o) { return min(texture2D(tSrc, vUv + o * texel).rgb * exposure, vec3(clampMax)); }
    void main() {
      vec3 c = 0.25 * (tap(vec2(-1.0, -1.0)) + tap(vec2(1.0, -1.0)) + tap(vec2(-1.0, 1.0)) + tap(vec2(1.0, 1.0)));
      float br = max(c.r, max(c.g, c.b));
      float soft = clamp(br - threshold + knee, 0.0, 2.0 * knee);
      soft = soft * soft / (4.0 * knee + 1e-4);
      gl_FragColor = vec4(c * max(soft, br - threshold) / max(br, 1e-4), 1.0);
    }`,
  depthTest: false, depthWrite: false,
});
const downMat = new THREE.ShaderMaterial({
  uniforms: { tSrc: { value: null }, texel: { value: new THREE.Vector2() } },
  vertexShader: quadVS,
  fragmentShader: /* glsl */`
    uniform sampler2D tSrc; uniform vec2 texel; varying vec2 vUv;
    void main() {
      gl_FragColor = 0.25 * (texture2D(tSrc, vUv + texel * vec2(-1.0, -1.0)) + texture2D(tSrc, vUv + texel * vec2(1.0, -1.0))
                           + texture2D(tSrc, vUv + texel * vec2(-1.0, 1.0)) + texture2D(tSrc, vUv + texel * vec2(1.0, 1.0)));
    }`,
  depthTest: false, depthWrite: false,
});
const upMat = new THREE.ShaderMaterial({
  uniforms: { tSrc: { value: null }, texel: { value: new THREE.Vector2() } },
  vertexShader: quadVS,
  fragmentShader: /* glsl */`
    uniform sampler2D tSrc; uniform vec2 texel; varying vec2 vUv;
    void main() {
      vec4 s = texture2D(tSrc, vUv) * 4.0;
      s += (texture2D(tSrc, vUv + texel * vec2(-1.0, 0.0)) + texture2D(tSrc, vUv + texel * vec2(1.0, 0.0))
          + texture2D(tSrc, vUv + texel * vec2(0.0, -1.0)) + texture2D(tSrc, vUv + texel * vec2(0.0, 1.0))) * 2.0;
      s += texture2D(tSrc, vUv + texel * vec2(-1.0, -1.0)) + texture2D(tSrc, vUv + texel * vec2(1.0, -1.0))
         + texture2D(tSrc, vUv + texel * vec2(-1.0, 1.0)) + texture2D(tSrc, vUv + texel * vec2(1.0, 1.0));
      gl_FragColor = s / 16.0;
    }`,
  blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false,
});
// center-weighted log-luminance meter for the slow auto exposure
const lumMat = new THREE.ShaderMaterial({
  uniforms: { tSrc: { value: null } },
  vertexShader: quadVS,
  fragmentShader: /* glsl */`
    uniform sampler2D tSrc; varying vec2 vUv;
    void main() {
      float l = dot(texture2D(tSrc, vUv).rgb, vec3(0.2126, 0.7152, 0.0722));
      vec2 q = vUv - 0.5;
      float w = max(0.05, 1.0 - 2.2 * dot(q, q));
      gl_FragColor = vec4(log(max(l, 1e-5)) * w, w, min(l, 50.0) * w, min(l, 50.0));
    }`,
  depthTest: false, depthWrite: false,
});
// "develop": cheap wide lens (barrel distortion + fringing), sensor falloff, harsh small-sensor tone curve,
// and a smear toward the previous frame, like a long shutter on a moving chest
const developMat = new THREE.ShaderMaterial({
  uniforms: {
    tColor: { value: null }, tBloom: { value: null }, tPrev: { value: null }, exposure: { value: 1 }, bloomStrength: { value: 0.03 },
    smear: { value: 0.1 }, distort: { value: 0.55 }, aspect: { value: 1.6 }, toneMappingExposure: { value: 1 },
  },
  vertexShader: quadVS,
  fragmentShader: /* glsl */`
    uniform sampler2D tColor, tBloom, tPrev;
    uniform float exposure, bloomStrength, smear, distort, aspect;
    varying vec2 vUv;
    #include <tonemapping_pars_fragment>
    vec2 barrel(vec2 uv, float k) {
      vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
      float corner = 0.25 * (aspect * aspect + 1.0);
      p *= (1.0 + k * dot(p, p)) / (1.0 + k * corner);
      return p / vec2(aspect, 1.0) + 0.5;
    }
    void main() {
      vec2 uvG = barrel(vUv, distort);
      vec3 c = vec3(texture2D(tColor, barrel(vUv, distort * 1.012)).r, texture2D(tColor, uvG).g, texture2D(tColor, barrel(vUv, distort * 0.988)).b);
      c = c * exposure + texture2D(tBloom, uvG).rgb * bloomStrength;
      vec2 q = (vUv - 0.5) * vec2(aspect, 1.0);
      c *= 1.0 - 0.45 * dot(q, q);
      c = NeutralToneMapping(c * 1.15);
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, 0.82) * vec3(0.97, 1.0, 1.03);
      c = max(c - 0.006, 0.0) * 1.006 + 0.012; // lifted, slightly crushed blacks
      gl_FragColor = vec4(mix(c, texture2D(tPrev, vUv).rgb, smear), 1.0);
    }`,
  depthTest: false, depthWrite: false,
});
// "encode": in-camera sharpening, 4:2:0-style blocky chroma, light macroblocking, sensor noise
const encodeMat = new THREE.ShaderMaterial({
  uniforms: { tSrc: { value: null }, res: { value: new THREE.Vector2(1, 1) }, time: { value: 0 }, noise: { value: 0.02 }, blocky: { value: 0.3 } },
  vertexShader: quadVS,
  fragmentShader: /* glsl */`
    uniform sampler2D tSrc; uniform vec2 res; uniform float time, noise, blocky;
    varying vec2 vUv;
    float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
    vec3 toYCC(vec3 c) { float y = dot(c, vec3(0.299, 0.587, 0.114)); return vec3(y, (c.b - y) * 0.565, (c.r - y) * 0.713); }
    vec3 fromYCC(vec3 v) { return vec3(v.x + 1.403 * v.z, v.x - 0.344 * v.y - 0.714 * v.z, v.x + 1.770 * v.y); }
    void main() {
      vec2 px = 1.0 / res;
      vec3 c = texture2D(tSrc, vUv).rgb;
      vec3 blur = 0.25 * (texture2D(tSrc, vUv + vec2(px.x, 0.0)).rgb + texture2D(tSrc, vUv - vec2(px.x, 0.0)).rgb
                        + texture2D(tSrc, vUv + vec2(0.0, px.y)).rgb + texture2D(tSrc, vUv - vec2(0.0, px.y)).rgb);
      c += (c - blur) * 0.4;
      vec2 block = (floor(gl_FragCoord.xy / 8.0) * 8.0 + 4.0) / res;
      vec3 cb = texture2D(tSrc, block).rgb;
      vec3 y = toYCC(max(c, 0.0)), yb = toYCC(cb);
      y.yz = mix(y.yz, yb.yz, 0.55 + 0.4 * blocky);
      float flatness = 1.0 - clamp(length(c - blur) * 12.0, 0.0, 1.0);
      y.x = mix(y.x, mix(y.x, yb.x, 0.35), blocky * flatness);
      float levels = mix(180.0, 70.0, blocky);
      y.x = floor(y.x * levels + 0.5) / levels * mix(1.0, 0.0, 1.0 - flatness) + y.x * (1.0 - flatness);
      c = fromYCC(y);
      float n = hash(vec3(gl_FragCoord.xy, time)) + hash(vec3(gl_FragCoord.yx + 13.0, time * 1.31)) - 1.0;
      float cn = hash(vec3(gl_FragCoord.xy * 0.5, time * 0.7)) - 0.5;
      float shadow = 1.0 - clamp(y.x * 1.6, 0.0, 1.0);
      c += n * noise * (0.35 + shadow) + vec3(cn, -cn * 0.6, cn * 0.4) * noise * shadow * 0.35;
      gl_FragColor = vec4(sRGBTransferOETF(vec4(max(c, 0.0), 1.0)).rgb, 1.0);
    }`,
  depthTest: false, depthWrite: false,
});

let exposure = 1, exposureTarget = 1, meterFrame = 0, cur = 0;
const lumBuf = new Float32Array(64 * 36 * 4);
const lumSort = new Float32Array(64 * 36);
function meter(dt) {
  if (meterFrame++ % 4 === 0) {
    lumMat.uniforms.tSrc.value = hdrRT.texture;
    fsq.material = lumMat;
    renderer.setRenderTarget(lumRT);
    fsq.render(renderer);
    renderer.readRenderTargetPixels(lumRT, 0, 0, 64, 36, lumBuf);
    let s = 0, w = 0, a = 0;
    for (let i = 0, j = 0; i < lumBuf.length; i += 4, j++) { s += lumBuf[i]; w += lumBuf[i + 1]; a += lumBuf[i + 2]; lumSort[j] = lumBuf[i + 3]; }
    const geo = Math.exp(s / Math.max(w, 1e-6)), mean = a / Math.max(w, 1e-6);
    lumSort.sort();
    const p97 = lumSort[Math.floor(lumSort.length * 0.97)]; // the fisheye magnifies the centre, so a torch pool is only a few % of this wide render
    const base = sky ? sky.autoExposure : 1;
    // expose mid-tones for the log average, but never let the plain average go past ~0.45: that keeps a torch
    // spot or a bright sky from blowing out just because most of the frame is dark
    // ...and keep the brightest few percent of the frame (a torch pool at night) below clipping
    const hi = 1.2 - 0.9 * (1 - lightK); // by day a bright sky may clip; at night the torch pool must not
    const t = Math.min(0.13 / Math.max(geo, 1e-5), 0.45 / Math.max(mean, 1e-5), hi / Math.max(p97, 1e-5));
    exposureTarget = Math.min(base * 10, Math.max(base * 0.3, t));
  }
  // bodycams brighten slowly and darken faster, so you see the exposure pump
  const rate = exposureTarget > exposure ? 0.8 : 2.4;
  exposure *= Math.pow(exposureTarget / exposure, 1 - Math.exp(-dt * rate));
}
function bloom() {
  prefilterMat.uniforms.tSrc.value = hdrRT.texture;
  prefilterMat.uniforms.texel.value.set(1 / hdrRT.width, 1 / hdrRT.height);
  prefilterMat.uniforms.exposure.value = exposure;
  fsq.material = prefilterMat;
  renderer.setRenderTarget(bloomRT[0]);
  fsq.render(renderer);
  fsq.material = downMat;
  for (let i = 1; i < BLOOM_LEVELS; i++) {
    downMat.uniforms.tSrc.value = bloomRT[i - 1].texture;
    downMat.uniforms.texel.value.set(1 / bloomRT[i - 1].width, 1 / bloomRT[i - 1].height);
    renderer.setRenderTarget(bloomRT[i]);
    fsq.render(renderer);
  }
  fsq.material = upMat;
  renderer.autoClear = false;
  for (let i = BLOOM_LEVELS - 1; i > 0; i--) {
    upMat.uniforms.tSrc.value = bloomRT[i].texture;
    upMat.uniforms.texel.value.set(1 / bloomRT[i].width, 1 / bloomRT[i].height);
    renderer.setRenderTarget(bloomRT[i - 1]);
    fsq.render(renderer);
  }
  renderer.autoClear = true;
}
let frameNo = 0;
function renderFootage(dt, smear, blocky) {
  renderer.setRenderTarget(hdrRT);
  renderer.render(scene, camera);
  meter(dt);
  bloom();
  const d = developMat.uniforms;
  d.tColor.value = hdrRT.texture; d.tBloom.value = bloomRT[0].texture; d.tPrev.value = ldrRT[1 - cur].texture;
  d.exposure.value = exposure; d.smear.value = smear; d.aspect.value = camera.aspect;
  fsq.material = developMat;
  renderer.setRenderTarget(ldrRT[cur]);
  fsq.render(renderer);
  const e = encodeMat.uniforms;
  e.tSrc.value = ldrRT[cur].texture; e.res.value.set(ldrRT[cur].width, ldrRT[cur].height); e.time.value = (frameNo++ % 997) + 1;
  // more gain, more noise: the sensor is being pushed in the dark
  const gain = Math.log2(exposure / (sky ? sky.autoExposure : 1));
  e.noise.value = 0.018 + 0.05 * Math.min(1, Math.max(0, gain / 3));
  e.blocky.value = blocky;
  fsq.material = encodeMat;
  renderer.setRenderTarget(null);
  fsq.render(renderer);
  cur = 1 - cur;
}

function resize() {
  const w = view.clientWidth, h = view.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / Math.max(1, h);
  camera.updateProjectionMatrix();
  hdrRT.setSize(w, h);
  for (const rt of ldrRT) rt.setSize(w, h);
  let bw = Math.max(1, w >> 1), bh = Math.max(1, h >> 1);
  for (const rt of bloomRT) { rt.setSize(bw, bh); bw = Math.max(1, bw >> 1); bh = Math.max(1, bh >> 1); }
}
new ResizeObserver(resize).observe(view);
window.addEventListener("resize", resize);
resize();

// ------------------------------------------------------------------ sound (all synthesized)
let AC = null, master = null, noiseBuf = null, windGain = null;
function initAudio() {
  if (AC) { AC.resume(); return; }
  AC = new (window.AudioContext || window.webkitAudioContext)();
  const comp = AC.createDynamicsCompressor(); // the camera mic's automatic gain
  comp.threshold.value = -26; comp.ratio.value = 6;
  master = AC.createGain(); master.gain.value = 0.9;
  master.connect(comp); comp.connect(AC.destination);
  noiseBuf = AC.createBuffer(1, AC.sampleRate * 2, AC.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const src = AC.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
  const lp = AC.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 380;
  windGain = AC.createGain(); windGain.gain.value = 0;
  src.connect(lp).connect(windGain).connect(master);
  src.start();
}
function burst({ type = "bandpass", freq = 1800, q = 0.9, gain = 0.3, attack = 0.003, decay = 0.08, rate = 1, when = 0 }) {
  if (!AC) return;
  const t = AC.currentTime + when;
  const s = AC.createBufferSource(); s.buffer = noiseBuf; s.playbackRate.value = rate;
  const f = AC.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
  const g = AC.createGain();
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + attack); g.gain.exponentialRampToValueAtTime(0.0005, t + attack + decay);
  s.connect(f).connect(g).connect(master);
  s.start(t, Math.random() * 1.5); s.stop(t + attack + decay + 0.05);
}
function tone({ type = "sine", freq = 1000, gain = 0.1, attack = 0.003, decay = 0.1, when = 0, slide = 0 }) {
  if (!AC) return;
  const t = AC.currentTime + when;
  const o = AC.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.linearRampToValueAtTime(freq + slide, t + attack + decay);
  const g = AC.createGain();
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + attack); g.gain.exponentialRampToValueAtTime(0.0005, t + attack + decay);
  o.connect(g).connect(master); o.start(t); o.stop(t + attack + decay + 0.05);
}
const sfx = {
  step(run) {
    burst({ freq: 1300 + Math.random() * 900, q: 0.7, gain: run ? 0.45 : 0.28, decay: run ? 0.11 : 0.09, rate: 0.8 + Math.random() * 0.4 });
    burst({ type: "lowpass", freq: 240, q: 0.5, gain: run ? 0.55 : 0.32, decay: 0.07 });
    for (let i = 0; i < 3; i++) burst({ freq: 3200 + Math.random() * 2500, q: 2, gain: 0.07, decay: 0.02, when: 0.02 + Math.random() * 0.08 });
  },
  radio() { tone({ type: "square", freq: 1250, gain: 0.04, decay: 0.07 }); burst({ type: "highpass", freq: 1800, gain: 0.1, decay: 0.2, when: 0.08 }); },
  snip() { burst({ freq: 5200, q: 3, gain: 0.35, decay: 0.03 }); tone({ type: "triangle", freq: 1900, gain: 0.07, decay: 0.4, slide: -700 }); },
  click() { burst({ freq: 3500, q: 4, gain: 0.25, decay: 0.015 }); },
};

// ------------------------------------------------------------------ radio and on-screen display
const radioQueue = [];
let radioUntil = 0, clockT = 0;
function radio(text, who = "CONTROL", now = false) {
  if (now) { radioQueue.unshift({ text, who }); radioUntil = 0; } else radioQueue.push({ text, who });
}
function updateRadio() {
  const sub = $("sub");
  if (clockT < radioUntil) return;
  if (!radioQueue.length) { sub.hidden = true; return; }
  const { text, who } = radioQueue.shift();
  sub.innerHTML = `<b>${who}</b>${text}`;
  sub.hidden = false;
  radioUntil = clockT + Math.max(3.5, text.length * 0.06);
  sfx.radio();
}
const pad = (n, w = 2) => String(Math.floor(n)).padStart(w, "0");
const START_CLOCK = 19 * 3600 + 12 * 60 + 40; // 19:12:40 local, about half an hour before sunset
function updateOSD(elapsed, heading) {
  const t = START_CLOCK + elapsed;
  $("elapsed").textContent = `${pad(elapsed / 3600)}:${pad((elapsed / 60) % 60)}:${pad(elapsed % 60)}`;
  $("stamp").textContent = `2026-11-20 ${pad(t / 3600)}:${pad((t / 60) % 60)}:${pad(t % 60)} +0200`;
  const lat = 29.68232 + player.pos.z / 111320, lon = 17.94919 + player.pos.x / (111320 * Math.cos(0.518));
  $("gps").textContent = `HDG ${pad(heading, 3)}°  S${lat.toFixed(5)} E${lon.toFixed(5)}`;
  $("rec").classList.toggle("off", Math.floor(clockT * 1.4) % 2 === 1);
  $("wires").textContent = `WIRES CUT ${snares.filter((s) => s.cut).length}/${snares.length}`;
  $("torchState").textContent = torch.intensity > 0 ? "TORCH ON" : "TORCH OFF";
}

// ------------------------------------------------------------------ player
const player = { pos: new THREE.Vector3(0.3, 0, 1.2), vel: new THREE.Vector3(), y: 0, yaw: 0, pitch: -0.08, yawT: 0, pitchT: -0.08, phase: 0, steps: 0, fatigue: 0 };
const keys = {};
let mode = "loading"; // loading | ready | playing | paused | done
let gameT = 0, lastYaw = 0, cutProgress = 0, warnedEdge = false, sunsetSaid = false, darkSaid = false, doneAt = 0;
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
  if (left === 0) {
    radio("Copy that, seven. Five down, that's the whole line. Good work. Head back to the truck.");
    mode = "done"; doneAt = clockT + 6;
  } else {
    radio(`Copy, ${snares.length - left} down. ${left} to go.`);
  }
}

function update(dt) {
  gameT += dt;
  // look: the chest turns a beat behind the mouse
  player.yaw += (player.yawT - player.yaw) * (1 - Math.exp(-dt * 13));
  player.pitch += (player.pitchT - player.pitch) * (1 - Math.exp(-dt * 11));
  // walk
  const run = keys.ShiftLeft || keys.ShiftRight;
  const fz = (keys.KeyW || keys.ArrowUp ? 1 : 0) - (keys.KeyS || keys.ArrowDown ? 1 : 0);
  const fx = (keys.KeyD || keys.ArrowRight ? 1 : 0) - (keys.KeyA || keys.ArrowLeft ? 1 : 0);
  fwd.set(-Math.sin(player.yaw), 0, -Math.cos(player.yaw));
  right.set(Math.cos(player.yaw), 0, -Math.sin(player.yaw));
  wish.set(0, 0, 0).addScaledVector(fwd, fz).addScaledVector(right, fx);
  if (wish.lengthSq() > 1) wish.normalize();
  const speed = run && fz > 0 ? 3.3 : 1.45;
  player.vel.lerp(wish.multiplyScalar(speed), 1 - Math.exp(-dt * 7));
  player.pos.addScaledVector(player.vel, dt);
  for (const s of solids) {
    const dx = player.pos.x - s.x, dz = player.pos.z - s.z, d = Math.hypot(dx, dz), min = s.r + 0.28;
    if (d < min && d > 1e-4) { player.pos.x = s.x + (dx / d) * min; player.pos.z = s.z + (dz / d) * min; }
  }
  const r = Math.hypot(player.pos.x, player.pos.z);
  if (r > PLAY_R) {
    player.pos.multiplyScalar(PLAY_R / r);
    if (!warnedEdge) { warnedEdge = true; radio("Seven, you're at the edge of the block. The wires are all inside it.", "CONTROL", true); }
  } else if (r < PLAY_R - 4) warnedEdge = false;
  const gy = heightAt(player.pos.x, player.pos.z);
  player.y += (gy - player.y) * (1 - Math.exp(-dt * 9));
  // gait: one step per half cycle, sway over a full cycle, everything scaled by speed
  const v = Math.hypot(player.vel.x, player.vel.z);
  const amp = smoothstep(0.1, 1.2, v) * (v > 2.2 ? 1.7 : 1);
  player.phase += dt * Math.PI * (v > 2.2 ? 2.7 : 1.85) * Math.min(1, v / 1.2);
  const step = Math.floor(player.phase / Math.PI);
  if (step !== player.steps) { player.steps = step; if (amp > 0.2) sfx.step(v > 2.2); }
  player.fatigue = Math.min(1, Math.max(0, player.fatigue + (v > 2.2 ? dt * 0.12 : -dt * 0.06)));
  const bob = -Math.abs(Math.sin(player.phase)) * 0.038 * amp;
  const sway = Math.sin(player.phase) * 0.022 * amp;
  const breathe = 0.003 + 0.01 * player.fatigue;
  const tt = gameT;
  camera.position.set(player.pos.x, player.y + EYE + bob + Math.sin(tt * 1.6) * breathe * 0.5, player.pos.z).addScaledVector(right, sway);
  camera.rotation.set(
    player.pitch + Math.abs(Math.cos(player.phase)) * 0.01 * amp + Math.sin(tt * 1.6) * breathe + Math.sin(tt * 7.3) * 0.0012,
    player.yaw + Math.sin(player.phase) * 0.007 * amp + Math.sin(tt * 0.9) * 0.003,
    Math.sin(player.phase) * 0.014 * amp + Math.sin(tt * 1.1) * 0.002,
  );
  // light
  const k = applyLighting(gameT);
  if (!sunsetSaid && k < 0.55) { sunsetSaid = true; radio("Sun's going, seven. Torch is on F if you need it."); }
  if (!darkSaid && k < 0.12) { darkSaid = true; radio("It's dark out there now. Watch your footing between the rocks."); }
  // interact
  const s = targetSnare();
  if (s && keys.KeyE) { cutProgress = Math.min(1, cutProgress + dt / 1.1); if (cutProgress >= 1) { cut(s); cutProgress = 0; } }
  else cutProgress = Math.max(0, cutProgress - dt * 3);
  $("prompt").hidden = !s;
  $("promptFill").style.width = `${Math.round(cutProgress * 100)}%`;
  // the mic picks up more wind as you move
  if (windGain) windGain.gain.setTargetAtTime(0.035 + 0.03 * (0.5 + 0.5 * Math.sin(tt * 0.37)) + v * 0.012, AC.currentTime, 0.4);
}

// ------------------------------------------------------------------ input
document.addEventListener("keydown", (e) => {
  keys[e.code] = true;
  if (mode !== "playing" || e.repeat) return;
  if (e.code === "KeyF") {
    const on = !(torch.intensity > 0);
    torch.intensity = on ? TORCH_CD : 0;
    torch.shadow.autoUpdate = on; // (switching castShadow itself would recompile every material)
    torch.shadow.needsUpdate = on;
    sfx.click();
  }
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
canvas.addEventListener("mousedown", () => { dragging = true; if (mode === "playing" && !dragLook && document.pointerLockElement !== canvas) lockPointer(); });
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
function pause() {
  mode = "paused";
  showCard("Paused", "The footage keeps rolling. Click to carry on.", "Resume patrol");
}
function showCard(title, text, button, keysVisible = false) {
  $("cardTitle").textContent = title;
  $("cardText").textContent = text;
  $("cardKeys").hidden = !keysVisible;
  $("status").textContent = "";
  $("go").textContent = button;
  $("go").disabled = false;
  $("screen").hidden = false;
}
$("go").addEventListener("click", () => {
  if (mode === "done") { location.reload(); return; }
  if (mode !== "ready" && mode !== "paused") return;
  initAudio();
  const first = mode === "ready";
  mode = "playing";
  $("screen").hidden = true;
  lockPointer();
  if (first) {
    radio("Ranger seven, Control. We've had reports of a snare line on the Rogland slope. Five wires. Find them and cut them before you lose the light.");
    radio("Your tracker has their last positions. Press Q for a bearing to the nearest one.");
  }
});

// ------------------------------------------------------------------ loop
let last = performance.now();
function step(dt) {
  clockT += dt;
  if (mode === "playing" || mode === "done") update(dt);
  if (mode === "done" && clockT > doneAt && $("screen").hidden) {
    if (document.pointerLockElement) document.exitPointerLock();
    const mins = Math.floor(gameT / 60), secs = Math.floor(gameT % 60);
    showCard("Patrol complete", `All ${snares.length} wires cut in ${mins}:${pad(secs)} on foot.`, "Patrol again");
  }
  if (sky) {
    sun.target.position.set(player.pos.x, player.y, player.pos.z);
    sun.position.copy(sun.target.position).addScaledVector(sunDir, 120);
    // the camera shakes harder and the encoder struggles more when you turn fast
    const turn = Math.abs(player.yaw - lastYaw) / Math.max(dt, 1e-3);
    lastYaw = player.yaw;
    const v = Math.hypot(player.vel.x, player.vel.z);
    renderFootage(dt, Math.min(0.55, 0.14 + turn * 0.09 + v * 0.02), Math.min(1, 0.2 + turn * 0.35 + v * 0.06));
    updateOSD(gameT, heading());
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
async function main() {
  const progress = setInterval(() => { if (filesTotal) $("status").textContent = `Loading scans: ${filesLoaded} / ${filesTotal} files`; }, 250);
  const [groundTex, s] = await Promise.all([loadGround(), loadSky(state.sky), loadModels()]).then(([g, s2]) => [g, s2]);
  sky = s;
  loadSky("rogland_overcast").then((n) => { nightSky = n; }).catch((err) => console.warn("No night sky:", err));
  for (const m of buildGameGround(groundTex)) world.add(m);
  setupSky();
  applyLighting(0);
  buildGameLayout();
  placeSnares();
  clearInterval(progress);
  player.y = heightAt(player.pos.x, player.pos.z);
  update(0.016);
  gameT = 0;
  let tris = 0;
  world.traverse((o) => { if (o.isMesh) { const g = o.geometry; tris += (g.index ? g.index.count : g.attributes.position.count) / 3; } });
  $("status").textContent = `Ready. ${fmtM(tris)} triangles of photoscans, ${snares.length} snares hidden.`;
  $("go").textContent = "Start patrol";
  $("go").disabled = false;
  mode = "ready";
}
main().catch((err) => {
  console.error(err);
  $("status").textContent = `Something failed while loading: ${err.message || err}`;
});

window.game = {
  THREE, renderer, scene, camera, player, keys, snares, solids, torch, sun,
  get mode() { return mode; }, set mode(v) { mode = v; }, get exposure() { return exposure; }, get gameT() { return gameT; }, set gameT(v) { gameT = v; },
  step, lookBy, cut, radio,
};
</script>
</body>
</html>
