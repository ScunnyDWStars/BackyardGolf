"""Write per-frame masks that hide burned-in video overlays (logos, yardage banners).

COLMAP reads them via --ImageReader.mask_path (file = <image name>.png, black = ignore),
and train.py excludes masked pixels from the loss.

Usage: python pipeline/make_masks.py <workdir> <clip_start_s> <fps> <until_s> x,y,w,h [x,y,w,h ...]
  Masks the given rectangles (in source pixels) on frames whose source time < until_s.
"""

import sys
from pathlib import Path

import numpy as np
from PIL import Image


def main():
    work, start, fps, until = Path(sys.argv[1]), float(sys.argv[2]), float(sys.argv[3]), float(sys.argv[4])
    rects = [tuple(int(v) for v in r.split(",")) for r in sys.argv[5:]]
    images = sorted((work / "images").glob("*.png"))
    out = work / "masks"
    out.mkdir(exist_ok=True)
    masked = 0
    for i, img in enumerate(images):
        w, h = Image.open(img).size
        m = np.full((h, w), 255, np.uint8)
        if start + i / fps < until:
            for x, y, rw, rh in rects:
                m[y : y + rh, x : x + rw] = 0
            masked += 1
        Image.fromarray(m).save(out / f"{img.name}.png")
    print(f"wrote {len(images)} masks ({masked} with overlays hidden) to {out}")


if __name__ == "__main__":
    main()
