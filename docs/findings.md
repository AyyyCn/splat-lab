# Findings

Notes and numbers from building these demos (November 2026, three.js r180, Spark 2.4, Chrome on an M-series Mac). Frame times are GPU-synced measurements at 1600×900 unless noted.

## What the study concluded

- **Photoreal in the browser** is reachable two ways. Path tracing photoscans gives the best image, but takes seconds per frame: about 3 s for a clean frame with WebGPU and the OIDN denoiser, where WebGL is still grainy after about 40 s. Gaussian splats give photoreal views at game frame rates, but the lighting is baked in.
- **AI-generated worlds** (World Labs Marble) are viable for a game made of many small places, not an open world.
  - Each world takes about 5 minutes to generate, costs about $1.70, spans 25–90 m and weighs 8–55 MB.
  - Limits: baked light, no level design control, style drift between worlds, nothing moves, one world is one location.
- **Map quality ranking**, best first:
  1. Rendered-then-splatted scenes (InteriorGS, the SA3D apartment). Clean from every angle.
  2. Newer Marble generations from real photos.
  3. The older Marble example exports.
  4. Photo scans. Photoreal, but only near the route their photos were taken from.
- **The opening for R&D** is the layer between a generated world and a playable level. Relighting was the first gap; the torch demo shows it's tractable per splat.

## Performance

| Change | Before | After |
|---|---|---|
| MSAA ×4 off on the footage HDR target | about 40 ms | about 16 ms |
| Synchronous exposure readback every 4th frame made async | 130–150 ms hitch every 4th frame | none |
| Village pruned 3.5M → 2.5M splats (no visible loss; 1.5M blotches the cobblestones) | about 16 ms | about 11 ms |
| Render scale 0.75 | — | barely helps: the cost is per splat (about 4 ms per million), not fill |
| Torch relighting (regenerating every splat each frame) | — | about +0 ms; shadow map +2 ms |
| Debris from 32 impacts | — | not measurable |
| Portal in view (both worlds drawn: 2.0M + 1.5M) | — | 15–18 ms; 6–10 ms otherwise |
| Splat hit test: hash grid vs Spark's raycast | about 50 ms per shot (2M splats) | 0–3 ms |

Other performance notes:
- Spark's level of detail (`createLodSplats`) takes about 30 s for 3.5M splats in a worker, so it's off by default.
- `accumExtSplats` (float colours, needed so night scenes don't band) costs nothing measurable.
- `gl.finish()` doesn't really synchronise on Chrome/Metal. Time GPU work with a 1×1 `readPixels` per frame instead.

## Gotchas

- **Marble exports**:
  - Raw exports are y-down (OpenCV axes) and their collider GLB has no node rotation. Some re-hosted worlds are already y-up.
  - Units aren't metres: the generation camera sits about 0.6–0.9 units above the ground.
- **Spark**:
  - Every `SparkRenderer`, including an offline one for `renderEnvMap`, must share the same `accumExtSplats` setting. Otherwise the shared splat program breaks all draws ("missing fragment shader outputs").
  - Its readback leaves a pixel-pack buffer bound, which makes later `readPixels` calls fail silently.
  - With `sparkOverride` set, every `SparkRenderer` object in the scene draws the override's data. `SparkPortals` adds two to the scene, so it double-draws. Keep one in the scene and call the other's `.render()`.
  - Dyno modifiers need their own instance per mesh. Uniforms can be shared.
- **Portals**: after walking through, push the player a little past the far disk and re-arm only once they've cleared it. Otherwise a collision nudge bounces them straight back.
- **Scans**:
  - Glass and plants often exist only as splats, not in a collider, so measure "open space" against the splats too.
  - A tilted scan levels well by fitting a plane to its lowest splats (RANSAC).
- **InteriorGS**:
  - Files are z-up metres with the floor at z = 0.
  - The occupancy map is mirrored on x relative to the splats.
  - The map counts outdoors as walkable, so find "indoors" by flooding in from the map's edges through spots with more than 55 cm of clearance; doorways stop the flood.
  - The scenes include a sky backdrop shell, which defeats "is there a ceiling" tests.

## Related work

- Relightable splats: LuxRemix, intrinsic decomposition of splats (ACM TOG 2026), NeAR (CVPR 2026).
- Splat segmentation and physics: ArtisanGS, PhysSplat, IGFuse.
- Open world generators: Tencent HY-World 2.0, NVIDIA Lyra 2.0.
- Real-time video world models: Genie 3, LingBot-World, Waypoint-1.
- Games built on Marble worlds: ICARE, STARSPEED, Rosebud.
