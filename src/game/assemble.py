# Builds demos/bodycam-scans/index.html: the path tracer's scene kit (scans, terrain, sky) plus the game.
import os
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, '..', '..'))
os.chdir(HERE)
src = open(os.path.join(REPO, 'demos/path-traced/index.html')).read()
M = "// ------------------------------------------------------------------ "
def between(a, b):
    i = src.index(a); j = src.index(b, i)
    return src[i:j]
def patch(text, reps):
    for a, b in reps:
        assert text.count(a) == 1, ('patch target not found once', a[:80])
        text = text.replace(a, b)
    return text

assets = patch(between(M + "assets", M + "renderer, scene, camera"), [
    ("""const LENSES = [14, 18, 24, 28, 35, 50, 70, 85, 105, 135];
const FSTOPS = [1.4, 2, 2.8, 4, 5.6, 8, 11, 16, 22, 0]; // 0 = pinhole, no depth of field
const RES = [0.5, 1, 2]; // path tracer pixels per CSS pixel
const RES_LABEL = ["Half", "1×", "Retina"];
""", ""),
])
i = assets.index("const state = {"); j = assets.index("};", i) + 2
assets = assets[:i] + 'const state = { sky: "rogland_sunset", sunAngle: 90 }; // sun due west of the start view (north is -Z)' + assets[j:]

terrain = patch(between(M + "terrain", M + "sky"), [
    ("const TERRAIN = { N: 512, disp: 0.07, nearEnd: 12, nearFade: 8, farStart: 7.5, farFade: 30, R: 72 };",
     "const TERRAIN = { N: 512, disp: 0.05, nearEnd: 37, nearFade: 31, farStart: 30, farFade: 46, R: 80, dispFadeA: 30, dispFadeB: 36 }; // game: walkable out to ~30 m"),
    ("const dispAmp = (r) => TERRAIN.disp * (1 - smoothstep(5, 10, r));",
     "const dispAmp = (r) => TERRAIN.disp * (1 - smoothstep(TERRAIN.dispFadeA, TERRAIN.dispFadeB, r));"),
    ("""  cv.width = img.width; cv.height = img.height;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  dispImg = { data: ctx.getImageData(0, 0, img.width, img.height).data, w: img.width, h: img.height };""",
     """  cv.width = cv.height = 256; // game: heights come from a softened copy, so a 12 cm grid doesn't alias the pebbles
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, 256, 256);
  dispImg = { data: ctx.getImageData(0, 0, 256, 256).data, w: 256, h: 256 };"""),
])

sky = between(M + "sky", "function applySky() {")
i = sky.index("  // The path tracer packs its environment"); j = sky.index("  const sunMax", i)
sky = sky[:i] + sky[j:]
sky = patch(sky, [
    ("id, full: tex, clipped: clip, ptEnv, hasSun:", "id, full: tex, clipped: clip, hasSun:"),
    ("const PT_ENV_SCALE = 8;\n", ""),
])
soften = between("// The realtime sun is a single point", M + "models")

models_layout = patch(between(M + "models", M + "path tracer"), [
    ("""  world.add(wrap);
  occupied.push(""", """  world.add(wrap);
  onPlace?.(id, wrap, size, scale, x, z); // game: collision circles and snare spots
  occupied.push("""),
    ("mask = null, around = null, behind = 0.3 }", "mask = null, around = null, behind = 1 }"),
])

out = open('head.html').read() + assets + terrain + sky + soften + models_layout + open('main.js').read()
open(os.path.join(REPO, 'demos/bodycam-scans/index.html'), 'w').write(out)
print('wrote', len(out.splitlines()), 'lines')
