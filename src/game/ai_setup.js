
// ================================================================== Last Light: AI world
// The same bodycam patrol, but the place is a Gaussian-splat world from a generator (World Labs Marble)
// instead of photoscans: light is baked into the splats, and collisions use the collider mesh that ships with it.

const $ = (id) => document.getElementById(id);
const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const TAU = Math.PI * 2;
const fmtM = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : Math.round(n / 1e3) + "k");

// Worlds. The default is a public example world from World Labs' developer docs (MIT-licensed repo).
// Your own Marble export works too: drop its .spz and collider .glb onto the page, or put them next to it
// and open ai-world.html?splat=my_world.spz&collider=my_world_collider.glb (optionally &scale=&spawn=x,y,z&flip=0|1).
// Scale "auto" sizes the world so its origin, the camera it was generated from, sits at standing eye height.
const GH = "https://raw.githubusercontent.com/icurtis1/gaussian-splat-character-controller/main/public";
const URLQ = new URLSearchParams(location.search);
const URL_FLIP = URLQ.get("flip") === "1" ? true : URLQ.get("flip") === "0" ? false : "auto";
const OWN_INTRO = "Seven, Control. Locals report a snare line out this way. Five wires. Find them and cut them.";
let WORLD = (() => {
  const q = URLQ;
  if (q.get("splat")) {
    return {
      label: q.get("name") || q.get("splat"),
      splat: q.get("splat"), collider: q.get("collider"),
      scale: q.get("scale") ? +q.get("scale") : "auto", position: [0, 0, 0],
      spawn: q.get("spawn") ? q.get("spawn").split(",").map(Number) : null,
      flip: URL_FLIP, intro: OWN_INTRO, portal: q.get("portal") || null,
      up: q.get("up") || (/3dgs_compressed\.ply/i.test(q.get("splat")) ? "z" : "y"), // InteriorGS scenes are z-up
      // ...and come with a walkable-floor map in the same folder
      occupancy: /3dgs_compressed\.ply$/i.test(q.get("splat")) && q.get("occ") !== "0"
        ? { json: q.get("splat").replace(/3dgs_compressed\.ply$/i, "occupancy.json"), png: q.get("splat").replace(/3dgs_compressed\.ply$/i, "occupancy.png") } : null,
    };
  }
  return {
    label: "Village, World Labs example world",
    splat: `${GH}/village2.spz`, collider: `${GH}/models/collider-v2.glb`,
    scale: 3.2, position: [0, 0, 14], spawn: [0, 1.5, 0], flip: "auto",
    intro: "Seven, Control. Locals report a snare line around the old village. Five wires. Find them and cut them.",
    portal: q.get("portal") === "0" ? null : q.get("portal") || "library",
  };
})();

// Worlds a portal can open onto: World Labs' raw example exports (MIT-licensed docs, CORS-enabled).
const EX = "https://wlt-ai-cdn.art/example_exports";
const exampleWorld = (id, label) => ({ label, splat: `${EX}/${id}/${id}_2m.spz`, collider: `${EX}/${id}/${id}_collider.glb` });
const PORTAL_WORLDS = {
  library: exampleWorld("elegant_library_with_fireplace", "Library, World Labs example world"),
  lane: exampleWorld("narrow_european_cobblestone_lane", "Cobblestone lane, World Labs example world"),
  house: exampleWorld("modern_house_with_lush_landscaping", "Modern house, World Labs example world"),
  kitchen: exampleWorld("rustic_kitchen_with_natural_light", "Rustic kitchen, World Labs example world"),
  // a scan with no collider of its own (one is built from its splats). CC-BY 4.0: credit Stéphane Agullo, sa3d.fr
  apartment: { label: "Apartment, SA3D_R&D_XP47 by Stéphane Agullo (CC-BY 4.0)", splat: "https://raw.githubusercontent.com/playcanvas/engine/main/examples/assets/splats/apartment.sog" },
};

// ------------------------------------------------------------------ renderer, scene, camera
const view = $("view");
const canvas = $("c");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
renderer.setPixelRatio(1);
renderer.toneMapping = THREE.NoToneMapping;
const scene = new THREE.Scene();
// Render budget. Splats are soft, so multisampling buys nothing but cost; bodycam footage is soft and noisy, so the
// 3D view renders below screen resolution and the footage pass scales it up; and Spark's level of detail caps how
// many splats are drawn. URL overrides for testing: ?msaa=4 &rs=1 &splats=4000000 &lod=1 &budget=2500000
const RENDER = {
  msaa: +(URLQ.get("msaa") ?? 0),
  scale: +(URLQ.get("rs") ?? 0.75),
  lod: URLQ.get("lod") === "1", // Spark's level of detail: smooth, but takes ~30 s to build for 3.5M splats
  budget: +(URLQ.get("budget") ?? 1.5e6),
  splats: +(URLQ.get("splats") ?? 2.5e6), // most splats kept per world: drawing is ~4 ms per million on this Mac
  ext: URLQ.get("ext") !== "0",
  portalSplats: [2.0e6, 1.5e6], // with a portal open both worlds can be on screen at once, so they share the budget
};
// H hides the on-screen display; C swaps the bodycam treatment for a clean camera (?clean=1 starts that way)
const VIEW = { ui: URLQ.get("ui") !== "0", clean: URLQ.get("clean") === "1" };

// One splat renderer draws everything, with Spark's portal shader: it can clip splats against a disk, which is
// how one world shows through a hole in the other (radius 0 switches the clipping off).
const portalUniforms = () => ({ diskCenter: { value: new THREE.Vector3() }, diskNormal: { value: new THREE.Vector3() }, diskRadius: { value: 0 }, diskTwoSided: { value: true } });
const spark = new SparkRenderer({ renderer, accumExtSplats: RENDER.ext, lodSplatCount: RENDER.budget, extraUniforms: portalUniforms(), fragmentShader: DISK_PORTAL_FRAGMENT_SHADER }); // float colours: night scenes are dark and heavily gained, 8 bits would band
scene.add(spark);
const world = new THREE.Group();
scene.add(world);
const EYE = 1.36;
const camera = new THREE.PerspectiveCamera(VIEW.clean ? 70 : 84, 1, 0.05, 1000); // 84° only reads right through the fisheye
camera.rotation.order = "YXZ";
scene.add(camera);
const sky = null; // no HDR sky here: the light lives in the splats
let lightK = 1;
