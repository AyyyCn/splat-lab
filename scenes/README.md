# Local scenes

Put scene files you've downloaded here. Everything in this folder except this README is ignored by git, because most scene licences don't allow redistribution.

## InteriorGS

[InteriorGS](https://github.com/manycore-research/InteriorGS) is 1,000 artist-designed interiors, rendered and turned into splats, each with a walkable-floor occupancy map. These are the best walkable maps found so far.

**Terms:** non-commercial research and education only, no redistribution, and they also bind your employer if you agree on its behalf. Read them on the [dataset page](https://huggingface.co/datasets/spatialverse/InteriorGS) before accepting.

1. Sign in to Hugging Face and accept the terms on the dataset page.
2. For each scene you want, download three files from its folder: `3dgs_compressed.ply` (about 45–57 MB), `occupancy.json` and `occupancy.png`.
3. Keep InteriorGS's layout:

   ```
   scenes/interiorgs/0001_839920/3dgs_compressed.ply
   scenes/interiorgs/0001_839920/occupancy.json
   scenes/interiorgs/0001_839920/occupancy.png
   ```

4. Open `demos/ai-worlds/?splat=../../scenes/interiorgs/0001_839920/3dgs_compressed.ply&portal=0`.

The page sees the `3dgs_compressed.ply` name and treats the scene as z-up. It also picks up the occupancy map next to it for the start point. You can drag the three files onto the start card instead.

## Your own scans

Any splat file works: a phone scan from an app like Scaniverse exported as `.spz`, a trained `.ply`, a `.splat` or a `.sog`. Collision is built from the splats.
- Phone scans come out in metres.
- Scans reconstructed from ordinary photos often don't, so add `&scale=` to fix the size.
- A scan only looks right near the route its photos were taken from, so capture by walking the route you want to play.
