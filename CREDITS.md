# Credits

None of these assets are stored in this repository. The pages load them from their authors' hosts at runtime. The exceptions are the two prepared panoramas in `assets/panoramas/` (derived from CC0 Poly Haven HDRIs) and the screenshots in `docs/images/`.

## Libraries

- [three.js](https://threejs.org): MIT
- [Spark](https://sparkjs.dev) (World Labs), Gaussian splat renderer for three.js: MIT
- [three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh): MIT
- [three-gpu-pathtracer](https://github.com/gkjohnson/three-gpu-pathtracer): MIT
- [oidn-web](https://github.com/pissang/oidn-web) and the Open Image Denoise weights: Apache-2.0

## Worlds and scenes

| Used in | Asset | Author / source | Licence |
|---|---|---|---|
| AI worlds (default) | Village (`village2.spz`, `collider-v2.glb`) | [icurtis1/gaussian-splat-character-controller](https://github.com/icurtis1/gaussian-splat-character-controller), generated with World Labs Marble | See that repository |
| AI worlds, portal | Library, cobblestone lane, modern house, rustic kitchen | World Labs example exports, `wlt-ai-cdn.art/example_exports` | World Labs; streamed, not redistributed |
| Scans, portal | Apartment, "SA3D_R&D_XP47" (`apartment.sog`) | Stéphane Agullo, [sa3d.fr](https://sa3d.fr), via [SuperSplat](https://superspl.at/view?id=cdcec084) and the PlayCanvas engine examples | **CC-BY 4.0**: credit required |
| Scans (tested) | Knock Community Hall (`knock-community-hall.sog`) | scbenoit via [SuperSplat](https://superspl.at/scene/0ff2e6dc) | **CC-BY 4.0**: credit required |
| Scans (tested) | Room (`room.splat`, Mip-NeRF 360 scene) | [cakewalk/splat-data](https://huggingface.co/cakewalk/splat-data) | Mixed and unclear: test use only |
| Relight lab | `fireplace.spz`, `rubberduck.glb` | [Spark](https://sparkjs.dev) example assets | Spark examples |
| Path tracer, photoscan game | Namaqualand boulders, rocks, stones, cliff, succulents and flowers; `rocky_trail` ground; HDRIs `rogland_sunset`, `klippad_sunrise_2`, `rogland_overcast`, `goegap` | [Poly Haven](https://polyhaven.com) | CC0 |
| Screenshots only | `docs/images/scan-room-*.jpg`, `maps-captured-room-*.jpg` show the Mip-NeRF 360 room scan | as above | Unclear: remove these before making the repo public |
| Bring your own | InteriorGS scenes | [manycore-research/InteriorGS](https://github.com/manycore-research/InteriorGS) | Non-commercial research and education only, **no redistribution**. Never commit these files or screenshots of them |
