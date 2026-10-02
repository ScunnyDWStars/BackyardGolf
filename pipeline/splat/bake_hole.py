"""Bake a playable hole from a trained splat: heightfield + orthophoto in the hole frame.

The ground the ball rolls on must agree with what the player sees, so the heightfield is
taken from the splat itself rather than a coarse public DEM: Gaussians are moved into
the hole frame (align.json), and each grid cell takes a low percentile of the opaque
Gaussians' heights (tree canopies sit above, so a low percentile finds the turf).

Outputs:
  <out_dir>/<name>.ortho.png       top-down colour image for drawing the hole layout
  <course_json>                     CourseData JSON consumed by the game, combining the
                                    heightfield with the hand-drawn layout file.

Usage:
  python pipeline/splat/bake_hole.py <ckpt.pt> <align.json> <layout.json> <course.json> \
      [--ortho out.png]
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import torch
from PIL import Image
from scipy import ndimage

import gs


def hole_frame_gaussians(ckpt_path: str, align_path: str):
    ck = torch.load(ckpt_path)
    align = json.loads(Path(align_path).read_text())
    T = np.array(align["matrix_row_major"])
    means = ck["means"].numpy()
    pts = means @ T[:3, :3].T + T[:3, 3]
    scale = align["scale_m_per_unit"]
    opac = torch.sigmoid(ck["opacities"]).numpy()
    size = np.exp(ck["scales"].numpy()).max(1) * scale
    rgb = np.clip(ck["sh0"].numpy() * gs.SH_C0 + 0.5, 0, 1)
    return pts, opac, size, rgb, align


def bake_heightfield(pts, opac, size, bounds, cell, percentile=30, min_count=3):
    (x0, x1), (z0, z1) = bounds
    cols = int(np.ceil((x1 - x0) / cell)) + 1
    rows = int(np.ceil((z1 - z0) / cell)) + 1
    keep = (opac > 0.4) & (size < 4.0)
    p = pts[keep]
    ci = np.round((p[:, 0] - x0) / cell).astype(int)
    ri = np.round((p[:, 2] - z0) / cell).astype(int)
    ok = (ci >= 0) & (ci < cols) & (ri >= 0) & (ri < rows)
    ci, ri, h = ci[ok], ri[ok], p[ok, 1]

    heights = np.full((rows, cols), np.nan)
    order = np.lexsort((h, ri * cols + ci))
    flat = (ri * cols + ci)[order]
    hs = h[order]
    starts = np.r_[0, np.flatnonzero(np.diff(flat)) + 1]
    ends = np.r_[starts[1:], len(flat)]
    for s, e in zip(starts, ends):
        if e - s >= min_count:
            idx = flat[s]
            heights.flat[idx] = hs[s + int((e - s - 1) * percentile / 100)]

    measured = ~np.isnan(heights)
    # Reject spikes: compare each cell against the median of its neighbourhood.
    med = ndimage.generic_filter(heights, np.nanmedian, size=5, mode="nearest")
    spikes = measured & (np.abs(heights - med) > 1.5)
    heights[spikes] = np.nan
    measured &= ~spikes

    # Fill holes by repeated neighbour averaging, then smooth lightly.
    filled = np.where(measured, heights, np.nanmedian(heights))
    for _ in range(200):
        blurred = ndimage.uniform_filter(filled, size=3, mode="nearest")
        filled = np.where(measured, heights, blurred)
    smooth = ndimage.gaussian_filter(filled, sigma=1.5, mode="nearest")
    return smooth, measured, (x0, z0, cols, rows)


def points_in_polygon(x: np.ndarray, z: np.ndarray, poly) -> np.ndarray:
    inside = np.zeros(x.shape, dtype=bool)
    n = len(poly)
    for i in range(n):
        xi, zi = poly[i]
        xj, zj = poly[i - 1]
        crosses = (zi > z) != (zj > z)
        xc = (xj - xi) * (z - zi) / np.where(zj == zi, 1e-12, zj - zi) + xi
        inside ^= crosses & (x < xc)
    return inside


def flatten_greens(hf, areas, x0, z0, cell, max_slope=0.025, margin_m=8.0, blend_m=12.0):
    """Putting surfaces need gentle, readable slopes, but reconstruction noise at grazing
    view angles makes them lumpy. Replace each green (plus a blend ring) with the best-fit
    plane of its baked heights, clamped to max_slope."""
    rows, cols = hf.shape
    zz, xx = np.mgrid[0:rows, 0:cols]
    X = x0 + xx * cell
    Z = z0 + zz * cell
    out = hf.copy()
    for area in areas:
        if area["lie"] != "green":
            continue
        inside = points_in_polygon(X, Z, area["polygon"])
        dist = ndimage.distance_transform_edt(~inside) * cell
        sel = dist <= margin_m
        A = np.c_[X[sel], Z[sel], np.ones(sel.sum())]
        (gx, gz, c), *_ = np.linalg.lstsq(A, hf[sel], rcond=None)
        g = np.hypot(gx, gz)
        if g > max_slope:
            gx, gz = gx * max_slope / g, gz * max_slope / g
            cx, cz = X[inside].mean(), Z[inside].mean()
            c = hf[inside].mean() - gx * cx - gz * cz
        plane = gx * X + gz * Z + c
        w = np.clip(1 - (dist - margin_m) / blend_m, 0, 1)
        out = w * plane + (1 - w) * out
        print(f"green flattened to {100 * np.hypot(gx, gz):.1f}% slope")
    return out


def bake_ortho(pts, opac, rgb, ground_fn, bounds, res=0.5, band=1.2):
    """Average colour of near-ground Gaussians per pixel (north-up = -Z up)."""
    (x0, x1), (z0, z1) = bounds
    w = int((x1 - x0) / res)
    h = int((z1 - z0) / res)
    gh = ground_fn(pts[:, 0], pts[:, 2])
    near = (np.abs(pts[:, 1] - gh) < band) & (opac > 0.2)
    p, c, a = pts[near], rgb[near], opac[near]
    u = ((p[:, 0] - x0) / res).astype(int)
    v = ((p[:, 2] - z0) / res).astype(int)
    ok = (u >= 0) & (u < w) & (v >= 0) & (v < h)
    acc = np.zeros((h, w, 3))
    wt = np.zeros((h, w))
    np.add.at(acc, (v[ok], u[ok]), c[ok] * a[ok, None])
    np.add.at(wt, (v[ok], u[ok]), a[ok])
    img = acc / np.maximum(wt, 1e-6)[..., None]
    img[wt < 1e-3] = [0.15, 0.15, 0.15]
    return (np.clip(img, 0, 1) * 255).astype(np.uint8)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("ckpt")
    ap.add_argument("align")
    ap.add_argument("layout")
    ap.add_argument("course")
    ap.add_argument("--ortho")
    ap.add_argument("--cell", type=float, default=6.0)
    args = ap.parse_args()

    layout = json.loads(Path(args.layout).read_text())
    bounds = (tuple(layout["extent"]["x"]), tuple(layout["extent"]["z"]))
    pts, opac, size, rgb, align = hole_frame_gaussians(args.ckpt, args.align)
    hf, measured, (x0, z0, cols, rows) = bake_heightfield(pts, opac, size, bounds, args.cell)
    hf = flatten_greens(hf, layout["hole"]["areas"], x0, z0, args.cell)
    print(f"heightfield {cols}x{rows} @ {args.cell} m, measured {measured.mean():.0%}, "
          f"range {hf.min():.2f}..{hf.max():.2f} m")

    def ground(x, z):
        c = np.clip((x - x0) / args.cell, 0, cols - 1)
        r = np.clip((z - z0) / args.cell, 0, rows - 1)
        return ndimage.map_coordinates(hf, [r, c], order=1, mode="nearest")

    if args.ortho:
        img = bake_ortho(pts, opac, rgb, ground, bounds)
        Image.fromarray(img).save(args.ortho)
        print(f"wrote {args.ortho} ({img.shape[1]}x{img.shape[0]}, 0.5 m/px)")

    def lift(p):
        return {"x": p[0], "y": float(ground(np.array([p[0]]), np.array([p[1]]))[0]), "z": p[1]}

    hole = layout["hole"]
    course = {
        "name": layout["name"],
        "attribution": layout["attribution"],
        "heightfield": {
            "originX": x0, "originZ": z0, "cellSize": args.cell, "cols": cols, "rows": rows,
            "heights": [round(float(v), 3) for v in hf.ravel()],
        },
        "bounds": layout["bounds"],
        "holes": [{
            "number": hole["number"], "par": hole["par"], "lengthYards": hole["lengthYards"],
            "tee": lift(hole["tee"]), "pin": lift(hole["pin"]),
            "centerline": hole["centerline"], "areas": hole["areas"],
        }],
        "splat": {"matrix": align["matrix_row_major"]},
    }
    Path(args.course).write_text(json.dumps(course, separators=(",", ":")))
    print(f"wrote {args.course}")


if __name__ == "__main__":
    main()
