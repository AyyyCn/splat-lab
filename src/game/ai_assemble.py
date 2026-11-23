# Builds demos/ai-worlds/index.html: the bodycam game's shared parts (footage look, snares, sound, radio)
# around the splat-world game in ai_setup.js and ai_main.js.
import os
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, '..', '..'))
os.chdir(HERE)
M = "// ------------------------------------------------------------------ "
main = open('main.js').read()
def between(src, a, b):
    i = src.index(a); j = src.index(b, i)
    return src[i:j]
def patch(text, reps):
    for a, b in reps:
        assert text.count(a) == 1, ('patch target not found once', a[:80])
        text = text.replace(a, b)
    return text

head = patch(open('head.html').read(), [
    ("<title>Last Light</title>", "<title>Last Light · AI World</title>"),
    ("""      <h1 id="cardTitle">Last Light</h1>
      <p id="cardText">Ranger bodycam, Namaqualand reserve. Poachers have set five wire snares on this slope. Find them and cut them before the light goes.</p>""",
     """      <h1 id="cardTitle">Last Light · AI world</h1>
      <p id="cardText">The same bodycam patrol, but in a world made by a generative model: <b id="worldName"></b>. Its daylight is baked into the splats; press N to put it out, F for your torch, and click to shoot lumps out of the walls. Find and cut the five snares.</p>"""),
    ("""        <li><b>F</b><span>Torch</span></li>""", """        <li><b>N</b><span>Lights out: night falls</span></li>
        <li><b>F</b><span>Torch</span></li>
        <li><b>Click</b><span>Fire (Space works too): knocks chunks out of whatever you hit</span></li>
        <li><b>Portal</b><span>Walk through the glowing ring into another world, and back</span></li>
        <li><b>V</b><span>Show the generated collision mesh</span></li>
        <li><b>H</b><span>Hide or show the on-screen display</span></li>
        <li><b>C</b><span>Bodycam filters on or off (a clean camera)</span></li>"""),
    ("""<span id="torchState">TORCH OFF</span>""", """<span id="torchState">DAYLIGHT BAKED IN</span>"""),
    ("""      </ul>
      <div id="status">""", """      </ul>
      <label id="drop"><input id="pick" type="file" accept=".spz,.ply,.splat,.ksplat,.sog,.glb,.json,.png" multiple>
        <b>Walk your own world or scan</b>
        <span id="dropText">Drop a Marble world's splats and collider (.spz + .glb) here, or a scan on its own (.spz, .ply, .splat).</span></label>
      <div id="status">"""),
    ("""  #overlay { display: none; }""", """  #drop {
    position: relative; display: block; margin: 0 0 14px; padding: 10px 12px; border: 1px dashed rgba(255, 255, 255, 0.22);
    border-radius: 7px; font-size: 13px; color: var(--muted); cursor: pointer;
  }
  #drop b { display: block; color: var(--text); font-weight: 600; }
  #drop input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
  #drop:hover, #drop.over { border-color: var(--accent); color: var(--text); }
  #drop.over { background: rgba(233, 162, 74, 0.08); }
  #drop:focus-within { outline: 2px solid #fff; outline-offset: 2px; }
  #drop[hidden] { display: none; }
  #view.noui .osd, #view.noui #sub, #view.noui #prompt { display: none !important; }
  #overlay { display: none; }"""),
    ('''    "three": "https://cdn.jsdelivr.net/npm/three@0.186.1/build/three.module.js",
    "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.186.1/examples/jsm/"''',
     '''    "three": "https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js",
    "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.180.0/examples/jsm/",
    "@sparkjsdev/spark": "https://sparkjs.dev/releases/spark/2.4.0/spark.module.js",
    "three-mesh-bvh": "https://cdn.jsdelivr.net/npm/three-mesh-bvh@0.9.16/build/index.module.js"'''),
    ('''import { HDRLoader } from "three/addons/loaders/HDRLoader.js";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";

// Scene kit: the code between here and "Last Light" below is copied from index.html (the path traced
// study) so both pages build the same Namaqualand scans, ground and sky.
''', '''import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import { SparkRenderer, SplatMesh, PackedSplats, DISK_PORTAL_FRAGMENT_SHADER, dyno } from "@sparkjsdev/spark";
import { MeshBVH, StaticGeometryGenerator } from "three-mesh-bvh";
'''),
])
snares = between(main, M + "snares", "const snares = [];")
footage = patch(between(main, M + "footage pipeline", M + "sound (all synthesized)"), [
    # C: a clean camera, with none of the bodycam treatment (lens, smear, grade, codec, noise)
    ("""    smear: { value: 0.1 }, distort: { value: 0.55 },""", """    smear: { value: 0.1 }, distort: { value: 0.55 }, clean: { value: 0 },"""),
    ("""    uniform float exposure, bloomStrength, smear, distort, aspect;
    varying vec2 vUv;
    #include <tonemapping_pars_fragment>""", """    uniform float exposure, bloomStrength, smear, distort, aspect, clean;
    varying vec2 vUv;
    #include <tonemapping_pars_fragment>"""),
    ("""    void main() {
      vec2 uvG = barrel(vUv, distort);""", """    void main() {
      if (clean > 0.5) {
        vec3 c0 = texture2D(tColor, vUv).rgb * exposure + texture2D(tBloom, vUv).rgb * bloomStrength * 0.5;
        gl_FragColor = vec4(NeutralToneMapping(c0 * 1.1), 1.0);
        return;
      }
      vec2 uvG = barrel(vUv, distort);"""),
    ("""  uniforms: { tSrc: { value: null }, res: { value: new THREE.Vector2(1, 1) }, time: { value: 0 }, noise: { value: 0.02 }, blocky: { value: 0.3 } },""",
     """  uniforms: { tSrc: { value: null }, res: { value: new THREE.Vector2(1, 1) }, time: { value: 0 }, noise: { value: 0.02 }, blocky: { value: 0.3 }, clean: { value: 0 } },"""),
    ("""    uniform sampler2D tSrc; uniform vec2 res; uniform float time, noise, blocky;""",
     """    uniform sampler2D tSrc; uniform vec2 res; uniform float time, noise, blocky, clean;"""),
    ("""    void main() {
      vec2 px = 1.0 / res;""", """    void main() {
      if (clean > 0.5) { gl_FragColor = vec4(sRGBTransferOETF(vec4(max(texture2D(tSrc, vUv).rgb, 0.0), 1.0)).rgb, 1.0); return; }
      vec2 px = 1.0 / res;"""),
    ("""  d.exposure.value = exposure; d.smear.value = smear; d.aspect.value = camera.aspect;""",
     """  d.exposure.value = exposure; d.smear.value = smear; d.aspect.value = camera.aspect; d.clean.value = VIEW.clean ? 1 : 0;"""),
    ("""  e.blocky.value = blocky;""", """  e.blocky.value = blocky; e.clean.value = VIEW.clean ? 1 : 0;"""),
    ("""function meter(dt) {
  if (meterFrame++ % 4 === 0) {""", """let meterBusy = false;
function meter(dt) {
  // read the meter back asynchronously: a blocking read every 4th frame made the CPU wait for the GPU
  // to finish everything queued, a 100+ ms hitch on big splat worlds
  if (!meterBusy && meterFrame++ % 4 === 0) {"""),
    ("""    renderer.readRenderTargetPixels(lumRT, 0, 0, 64, 36, lumBuf);
    let s = 0""", """    // the pixel-pack binding Spark's readback leaves behind breaks reads; three's async read binds its own
    meterBusy = true;
    renderer.readRenderTargetPixelsAsync(lumRT, 0, 0, 64, 36, lumBuf).then(meterRead, () => {}).finally(() => { meterBusy = false; });
  }
  // bodycams brighten slowly and darken faster, so you see the exposure pump
  const rate = exposureTarget > exposure ? 0.8 : 2.4;
  exposure *= Math.pow(exposureTarget / exposure, 1 - Math.exp(-dt * rate));
}
function meterRead() {
  {
    let s = 0"""),
    ("""    exposureTarget = Math.min(base * 10, Math.max(base * 0.3, t));
  }
  // bodycams brighten slowly and darken faster, so you see the exposure pump
  const rate = exposureTarget > exposure ? 0.8 : 2.4;
  exposure *= Math.pow(exposureTarget / exposure, 1 - Math.exp(-dt * rate));
}""", """    exposureTarget = Math.min(base * 10, Math.max(base * 0.3, t));
  }
}"""),
    ("""  renderer.setRenderTarget(hdrRT);
  renderer.render(scene, camera);""", """  renderer.setRenderTarget(hdrRT);
  renderWorld(); // one pass, or two when a portal is in view"""),
    ("""const hdrRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });""",
     """const hdrRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: RENDER.msaa });"""),
    ("""  hdrRT.setSize(w, h);
  for (const rt of ldrRT) rt.setSize(w, h);
  let bw = Math.max(1, w >> 1), bh = Math.max(1, h >> 1);""",
     """  const rs = VIEW.clean ? 1 : RENDER.scale; // the clean camera gets full resolution
  const sw = Math.max(1, Math.round(w * rs)), sh = Math.max(1, Math.round(h * rs));
  hdrRT.setSize(sw, sh); // the 3D view, scaled up by the develop pass
  for (const rt of ldrRT) rt.setSize(w, h);
  let bw = Math.max(1, sw >> 1), bh = Math.max(1, sh >> 1);"""),
])
sound = between(main, M + "sound (all synthesized)", M + "radio and on-screen display")
osd = patch(between(main, M + "radio and on-screen display", M + "player"), [
    ('''  $("torchState").textContent = torch.intensity > 0 ? "TORCH ON" : "TORCH OFF";\n''', ""),
])
shared = "\n// ---- shared with game.html (footage look, snares, sound, radio) ----\n"
out = head + open('ai_setup.js').read() + shared + snares + footage + sound + osd + open('ai_main.js').read()
open(os.path.join(REPO, 'demos/ai-worlds/index.html'), 'w').write(out)
print('wrote', len(out.splitlines()), 'lines')
