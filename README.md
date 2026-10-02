# Backyard Golf

A browser golf game in the spirit of *Tiger Woods PGA Tour 08*: analog mouse swing, broadcast
cameras and HUD, aim arc, putting grid. It is played on **real courses**, reconstructed as
3D Gaussian splats from flyover video.

The first playable hole is **Romanby Golf & Country Club, hole 2** (par 4, 382 yd). It was
reconstructed from a drone flyover video with the CPU splat pipeline in `pipeline/`.

## Play

```bash
npm install
npm run dev          # http://localhost:5173
```

| Input | Action |
| --- | --- |
| Drag mouse **down**, then push **up** | Swing. Backswing depth sets power, downswing time sets tempo, sideways drift curves the ball (right = fade/slice, left = draw/hook) |
| ← / → (Shift = faster) | Aim |
| ↑ / ↓ | Change club |
| O | Overhead view of the landing area |
| V | Toggle photoreal splat / stylized terrain |
| L | Load a splat file (.ply / .spz) from disk |
| Space | Skip flyover / ball flight |
| R | Restart hole |

On phones and tablets the on-screen buttons do the same: aim ◀ ▶ (hold), club ▲ ▼, overhead ⌖, view ◐, skip ⏭, restart ↺.

URL options: `?wind=<mph>&windDir=<deg>`, `?flyover=0`, `?splat=<url>` or `?splat=none`,
`?course=<course json>`.

**The splat file is not in this repository.** It is derived from third-party footage, and
publishing it would need the rights holder's permission. Run the pipeline below to make your
own copy at `data/romanby-h2-full/splat/splat.ply`, which the dev server loads automatically.
You can also press **L** to load any splat. Without one, the hole plays on the stylized
terrain, which is built from the same reconstruction.

## How a course is made

```
flyover video ──ffmpeg──> frames ──COLMAP──> camera poses + sparse points
      │                                              │
      │                   pipeline/splat/train.py <──┘   (CPU 3DGS, C++ rasterizer)
      │                              │
      └─ on-screen yardage ──> align.py (metric scale, Y-up hole frame)
                                     │
                    bake_hole.py ────┴──> public/courses/<hole>.json
                    (heightfield from ground-level splats + hand-measured layout)
```

- **Visuals and physics are separate.** Splats have no surfaces for the ball to hit, so the
  ball uses a heightfield. That heightfield is baked *from the same splat*, so the ball sits
  on the turf you see. Greens are flattened to at most 2.5% slope, because reconstruction
  noise at drone grazing angles would otherwise make them unputtable.
- **Scale.** Video alone has no metric scale. `align.py` uses the scorecard length (382 yd)
  and the drone's ground track. Treat it as roughly ±15%.
- **Layout.** Positions of the green, pin and pond were measured by casting rays from the
  reconstructed camera poses (see `pipeline/courses/romanby-h2.layout.json`).

### Rebuild the Romanby splat (CPU only, about 1–2 h on 4 cores)

```bash
apt-get install colmap ffmpeg
pip install torch numpy pillow plyfile scipy
W=data/romanby-h2-full
# Stop before the end card (60.5 s); mask the logo and yardage banner shown until 9.7 s.
pipeline/extract_frames.sh <flyover.mp4> $W 0 60.3 5
python pipeline/make_masks.py $W 0 5 9.7 225,0,190,110 0,262,432,90
pipeline/sfm.sh $W
cd pipeline/splat
python train.py ../../$W/undistorted ../../$W/splat --iters 7000
python align.py ../../$W/undistorted ../../$W/align.json \
  --hole-length-yd 382 --clip-start 0 --clip-end 60.3
python bake_hole.py ../../$W/splat/ckpt.pt ../../$W/align.json \
  ../courses/romanby-h2.layout.json ../../public/courses/romanby-h2.json
python render_view.py ../../$W/splat/ckpt.pt ../../$W/align.json \
  out.png --eye 10 3 -150 --target 20 0 -250      # spot-check a view
```

`python pipeline/tests/test_rasterize.py` checks the C++ rasterizer's forward pass and
gradients against a dense PyTorch reference.

### Private build with the splat bundled

```bash
python pipeline/splat/export_splat.py data/romanby-h2-full/splat/ckpt.pt dist-splat.splat \
  --base64 romanby-hole2.splat.b64.txt     # 2.9 MB .splat, base64 copy for text-only hosts
VITE_SPLAT_URL=romanby-hole2.splat.b64.txt npm run build
cp romanby-hole2.splat.b64.txt dist/        # keep this build private (club footage)
```

`VITE_SPLAT_URL` may point at a `.ply`, `.spz` or `.splat` directly, or at a `*.b64.txt`
copy, which the game decodes. Without it, a build ships no splat.

### Any course from OpenStreetMap + public elevation

```bash
npx tsx scripts/fetch-osm.ts nearby 54.34 -1.45 15          # find courses near a point
npx tsx scripts/fetch-osm.ts course way <id> osm.json       # golf features of one course
npx tsx scripts/bake-course.ts osm.json 2 public/courses/my-hole.json
# then open /?course=courses/my-hole.json
```

Hole layouts come from OSM `golf=*` tags and elevation from AWS Terrain Tiles (Terrarium).
That covers any mapped course, but with stylized visuals only until someone captures a splat.

## Code map

| Path | What |
| --- | --- |
| `src/physics/ball.ts` | 240 Hz ball flight (drag + Magnus lift, calibrated to tour carries), bounce/roll by lie, cup capture |
| `src/swing/analogSwing.ts` | TW08-style analog swing → launch parameters |
| `src/game/session.ts` | Hole state machine: clubs, strokes, water/OB penalties, holing out |
| `src/course/` | Course schema, terrain queries, OSM converter |
| `src/render/` | Stylized terrain, Spark splat layer, broadcast cameras |
| `src/ui/hud.ts` | Broadcast HUD |
| `pipeline/` | Video → splat → playable hole (Python + C++) |

`npm test` runs the unit tests (physics bands, swing mapping, penalties, OSM baking).
`npm run typecheck` and `npm run lint` must stay clean.
`node scripts/playtest.mjs http://localhost:5173/ out/` plays the hole headlessly and saves
screenshots.

## Known limits / next steps

- The splat looks right only near the drone's flight line (low, straight down the fairway).
  Views from far off that path show floaters. Orbit or grid captures would fix this.
- Course search UI (M2), in-app capture upload with GPU training (M3), full 18-hole rounds
  and multiplayer (M4).
