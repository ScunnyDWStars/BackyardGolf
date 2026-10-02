"""Render a trained splat from a camera given in the hole frame (metres, +Y up).

  top-down orthophoto-style view:
    python render_view.py ckpt.pt align.json out.png --topdown --extent -140 160 -420 60
  perspective view:
    python render_view.py ckpt.pt align.json out.png --eye 0 30 40 --target 0 0 -150
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import torch
from PIL import Image

import gs


def look_at_rows(eye: np.ndarray, target: np.ndarray, up_hint=np.array([0.0, 1.0, 0.0])):
    """World->camera rotation (rows = camera x right, y down, z forward) in the hole frame."""
    fwd = target - eye
    fwd /= np.linalg.norm(fwd)
    right = np.cross(fwd, up_hint)
    if np.linalg.norm(right) < 1e-6:
        right = np.cross(fwd, np.array([0.0, 0.0, -1.0]))
    right /= np.linalg.norm(right)
    down = np.cross(fwd, right)
    return np.stack([right, down, fwd])


def make_view(R_h, eye_h, align, fx, fy, cx, cy, w, h, background):
    """Express a hole-frame camera in the splat's COLMAP frame."""
    T = np.array(align["matrix_row_major"])
    s = align["scale_m_per_unit"]
    R_a = T[:3, :3] / s
    t_a = T[:3, 3]
    R = R_h @ R_a
    t = R_h @ (t_a - eye_h) / s
    return gs.View("virtual", torch.tensor(R, dtype=torch.float32), torch.tensor(t, dtype=torch.float32),
                   fx, fy, cx, cy, w, h, torch.zeros(h, w, 3))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("ckpt")
    ap.add_argument("align")
    ap.add_argument("out")
    ap.add_argument("--topdown", action="store_true")
    ap.add_argument("--extent", type=float, nargs=4, default=[-140, 160, -420, 60])
    ap.add_argument("--res", type=float, default=0.5, help="metres per pixel (top-down)")
    ap.add_argument("--eye", type=float, nargs=3)
    ap.add_argument("--target", type=float, nargs=3)
    ap.add_argument("--size", type=int, nargs=2, default=[960, 540])
    ap.add_argument("--fov", type=float, default=55)
    args = ap.parse_args()

    ck = torch.load(args.ckpt)
    params = {k: ck[k] for k in ["means", "scales", "quats", "opacities", "sh0", "sh1"]}
    align = json.loads(Path(args.align).read_text())

    if args.topdown:
        x0, x1, z0, z1 = args.extent
        w, h = int((x1 - x0) / args.res), int((z1 - z0) / args.res)
        height = 3000.0
        eye = np.array([(x0 + x1) / 2, height, (z0 + z1) / 2])
        # Looking straight down with -Z (towards the green) at the top of the image.
        R_h = np.array([[1.0, 0, 0], [0, 0, 1.0], [0, -1.0, 0]])
        f = height / args.res
        view = make_view(R_h, eye, align, f, f, w / 2, h / 2, w, h, None)
        bg = torch.tensor([0.12, 0.12, 0.12])
    else:
        w, h = args.size
        eye, target = np.array(args.eye), np.array(args.target)
        R_h = look_at_rows(eye, target)
        f = (w / 2) / np.tan(np.radians(args.fov) / 2)
        view = make_view(R_h, eye, align, f, f, w / 2, h / 2, w, h, None)
        bg = ck["background"]

    with torch.no_grad():
        img = gs.render(params, view, bg)["image"].clamp(0, 1)
    Image.fromarray((img.numpy() * 255).astype(np.uint8)).save(args.out)
    print(f"wrote {args.out} ({w}x{h})")


if __name__ == "__main__":
    main()
