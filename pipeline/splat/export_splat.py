"""Export a trained checkpoint to the compact .splat format (32 bytes per Gaussian).

Layout per Gaussian (little endian), as read by Spark, antimatter15/splat and others:
  position  float32 x3
  scale     float32 x3   (linear, not log)
  colour    uint8 x4     (RGB from the SH DC term, A = opacity)
  rotation  uint8 x4     (unit quaternion w,x,y,z mapped from [-1,1] to [0,255])
View-dependent SH bands are dropped. Gaussians are sorted by visual weight so a partial
download still shows the important ones first.

Usage: python export_splat.py <ckpt.pt> <out.splat> [--base64 out.b64.txt]
"""

from __future__ import annotations

import argparse
import base64
from pathlib import Path

import numpy as np
import torch

import gs


def to_splat_bytes(ck: dict) -> bytes:
    means = ck["means"].numpy().astype(np.float32)
    scales = np.exp(ck["scales"].numpy()).astype(np.float32)
    rgb = np.clip(ck["sh0"].numpy() * gs.SH_C0 + 0.5, 0, 1)
    alpha = torch.sigmoid(ck["opacities"]).numpy()
    q = ck["quats"].numpy()
    q = q / np.linalg.norm(q, axis=1, keepdims=True)

    order = np.argsort(-(scales.prod(1) * alpha))
    n = len(means)
    rec = np.zeros(n, dtype=[("pos", "<f4", 3), ("scale", "<f4", 3), ("rgba", "u1", 4), ("rot", "u1", 4)])
    rec["pos"] = means[order]
    rec["scale"] = scales[order]
    rec["rgba"] = (np.c_[rgb, alpha[:, None]][order] * 255).round().clip(0, 255)
    rec["rot"] = (q[order] * 128 + 128).round().clip(0, 255)
    return rec.tobytes()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("ckpt")
    ap.add_argument("out")
    ap.add_argument("--base64", help="also write a base64 text copy (for hosts that only serve text)")
    args = ap.parse_args()
    data = to_splat_bytes(torch.load(args.ckpt))
    Path(args.out).write_bytes(data)
    print(f"wrote {args.out}: {len(data) // 32} splats, {len(data) / 1e6:.2f} MB")
    if args.base64:
        Path(args.base64).write_text(base64.b64encode(data).decode("ascii"))
        print(f"wrote {args.base64}: {Path(args.base64).stat().st_size / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
