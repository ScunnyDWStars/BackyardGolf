# Backyard Golf

A browser golf game in the spirit of *Tiger Woods PGA Tour 08*: analog mouse swing, broadcast
cameras and HUD, aim arc, putting grid. It is played on **real courses**, reconstructed as
3D Gaussian splats from flyover video.

The default course is **Romanby Golf Club**, all 18 holes, baked from OpenStreetMap and
public elevation data in a stylized look. **Hole 2** can also be played photoreal: it was
reconstructed from a drone flyover video with the CPU splat pipeline in `pipeline/`, then
placed into the map course using the map's tee and green. Course data licences are listed
in `public/courses/README.md`.

## Play

```bash
npm install
npm run dev          # http://localhost:5173
```

| Input | Action |
| --- | --- |
| Click / tap / Space ×3 | **3-click meter** for putts and shots inside 100 yds (or every shot, from the scorecard setting): start, stop at the ⚑ mark for the power that reaches the hole (slope, lie and wind included), then stop in the green zone. Early = left, late = right |
| Drag mouse **down**, then push **up** | Swing. Backswing depth sets power, downswing time sets tempo, sideways drift curves the ball (right = fade/slice, left = draw/hook) |
| ← / → (Shift = faster) | Aim |
| ↑ / ↓ | Change club |
| O | Overhead view of the landing area |
| V | Toggle photoreal splat / stylized terrain |
| L | Load a splat file (.ply / .spz) from disk |
| Space | Skip flyover / ball flight |
| R | Restart hole |
| C | Scorecard (tap a hole number to play it; **Change course** opens the course list) |

On phones and tablets the on-screen buttons do the same: aim ◀ ▶ (hold), club ▲ ▼, overhead ⌖, skip ⏭, restart ↺, scorecard ▤. The Photoreal / Stylized switch is at the top right.

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

Many courses are already traced in OpenStreetMap (fairways, greens, bunkers, water, tees,
`golf=hole` lines with par). That plus public elevation gives every hole of a course in the
stylized look.

1. Get the data. Either run `npx tsx scripts/fetch-osm.ts course way <id> osm.json`, or open
   https://overpass-turbo.eu, run a query for the course's golf features with `out geom;`,
   and use Export → "raw OSM data".
2. Bake it: `npx tsx scripts/bake-course.ts osm.json public/courses/my-course.json`. Add
   `"1-9"` to bake only some holes. Elevation comes from AWS Terrain Tiles (Terrarium).
   Bunkers are dug in, water sits below its banks, and tee boxes are levelled.
3. Play it: open `/?course=courses/my-course.json`. Add `&hole=7` to start on a hole.

**Adding a course to the in-game list** (the published game can't reach map servers, so
courses are baked here and shipped with it):

```bash
npx tsx scripts/course-request.ts "Old Course, St Andrews" 56.348 -2.811   # prints an overpass-turbo link
# open the link, Export → raw OSM data, save as data/<id>-osm.json, then:
npx tsx scripts/bake-course.ts data/<id>-osm.json public/courses/<id>.json --course "Old Course"
npx tsx scripts/catalog.ts                                                   # refresh courses/index.json
```

`--course` picks one course when several share the land: play areas must sit inside that
course's outline, and if hole numbers still repeat, the holes are chained by the shortest
green-to-next-tee walks. The bake summary lists par, yardage and any hole numbers without
mapped hole lines. Place names for the list live in `pipeline/courses/catalog-meta.json`.

To keep a photoreal hole inside a mapped course, attach its capture. The map's tee and
green fix the capture's position, rotation and true scale:

```bash
npx tsx scripts/attach-splat.ts public/courses/my-course.json public/courses/romanby-h2.json 2 \
  public/courses/my-course.json romanby-hole2.splat.b64.txt
```

`npx tsx scripts/make-sample-course.ts osm.json` writes a synthetic three-hole course (not a
real place) for trying the pipeline offline.

## Code map

| Path | What |
| --- | --- |
| `src/physics/ball.ts` | 240 Hz ball flight (drag + Magnus lift, calibrated to tour carries), bounce/roll by lie, cup capture |
| `src/swing/analogSwing.ts` | TW08-style analog swing → launch parameters |
| `src/game/session.ts`, `round.ts` | Hole state machine (clubs, strokes, water/OB penalties, holing out) and the round/scorecard |
| `src/course/` | Course schema, terrain queries, OSM course baker, splat attachment |
| `src/render/` | Stylized course look (`courseLook.ts`), Spark splat layer, broadcast cameras |
| `src/ui/hud.ts` | Broadcast HUD |
| `pipeline/` | Video → splat → playable hole (Python + C++) |

`npm test` runs the unit tests (physics bands, swing mapping, penalties, OSM baking).
`npm run typecheck` and `npm run lint` must stay clean.
`node scripts/playtest.mjs http://localhost:5173/ out/` plays the hole headlessly and saves
screenshots.

## Known limits / next steps

- The splat looks right only near the drone's flight line (low, straight down the fairway).
  Views from far off that path show floaters. Orbit or grid captures would fix this.
- Course search inside the game needs a small server: the published page cannot call
  OpenStreetMap directly. Next: in-app capture upload with GPU training, and multiplayer.
