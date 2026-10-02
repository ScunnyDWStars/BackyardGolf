"""Compute a similarity transform from the COLMAP frame to a metric, Y-up "hole frame".

Hole frame (matches Three.js conventions): +Y up, -Z points down the hole from tee to
green, +X to the golfer's right, origin on the ground at the estimated tee, units = metres.

Up comes from a RANSAC plane fit to the sparse points (the fairway dominates), oriented
towards the cameras. Forward is the drone's direction of travel projected onto that plane.

Scale cannot be recovered from monocular video. We estimate it from the hole's scorecard
length and the drone track: the flyover runs tee -> green at a roughly constant speed, so
the trimmed clip's track is extrapolated back to the tee using the clip start offset, and
the far end is taken as the last camera's ground point. Treat it as approximate (+/-15%)
until refined with surveyed points (tee and pin) in the game's alignment tool.

Usage:
  python pipeline/splat/align.py <undistorted_dir> <out.json> --hole-length-yd 382 \
      --clip-start 9.6 --clip-end 60.3 [--flight-start 0]
"""

from __future__ import annotations

import argparse
import json

import numpy as np

import gs

YARD = 0.9144


def ransac_plane(pts: np.ndarray, iters=2000, thresh=None, seed=0):
    rng = np.random.default_rng(seed)
    if thresh is None:
        thresh = 0.01 * np.linalg.norm(pts.max(0) - pts.min(0))
    best, best_n = None, -1
    for _ in range(iters):
        a, b, c = pts[rng.choice(len(pts), 3, replace=False)]
        n = np.cross(b - a, c - a)
        if np.linalg.norm(n) < 1e-9:
            continue
        n /= np.linalg.norm(n)
        inl = np.abs((pts - a) @ n) < thresh
        if inl.sum() > best_n:
            best, best_n = inl, inl.sum()
    # Refine with least squares on the inliers.
    p = pts[best]
    centroid = p.mean(0)
    _, _, vt = np.linalg.svd(p - centroid)
    return vt[2], centroid, best


def fit_ground(centers: np.ndarray, image_up: np.ndarray, xyz: np.ndarray):
    """Fit the ground plane under the drone track. Returns (up, point_on_plane).

    Only points near the track and below the cameras are used: distant tree lines sit
    around camera height on the horizon and would otherwise win RANSAC."""
    up0 = image_up.mean(0)
    up0 /= np.linalg.norm(up0)
    track_len = np.linalg.norm(centers[-1] - centers[0])
    d = np.linalg.norm(xyz[:, None] - centers[None], axis=2)
    nearest = d.argmin(1)
    below = (xyz - centers[nearest]) @ up0 < 0
    near = d.min(1) < 0.2 * track_len
    ground = xyz[below & near]
    normal, centroid, inliers = ransac_plane(ground, thresh=0.002 * track_len)
    if normal @ up0 < 0:
        normal = -normal
    print(f"ground fit on {len(ground)} / {len(xyz)} points ({inliers.mean():.0%} inliers), "
          f"tilt from image-up {np.degrees(np.arccos(np.clip(normal @ up0, -1, 1))):.1f} deg")
    return normal, centroid


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("data")
    ap.add_argument("out")
    ap.add_argument("--hole-length-yd", type=float, required=True)
    ap.add_argument("--clip-start", type=float, required=True, help="clip start time in source (s)")
    ap.add_argument("--clip-end", type=float, required=True)
    ap.add_argument("--flight-start", type=float, default=0.0,
                    help="source time at which the drone is over the tee (s)")
    args = ap.parse_args()

    views, xyz, _ = gs.load_colmap(args.data)
    centers = np.stack([v.center.numpy() for v in views])
    image_up = np.stack([-v.R.numpy()[1] for v in views])  # camera -y axis in world

    up, centroid = fit_ground(centers, image_up, xyz)

    def to_ground(p):
        return p - ((p - centroid) @ up)[..., None] * up

    ground_track = to_ground(centers)
    travel = ground_track[-1] - ground_track[0]
    fwd = travel / np.linalg.norm(travel)
    right = np.cross(fwd, up)

    # Per-frame times in the source video, assuming frames are evenly spaced over the clip.
    t = np.linspace(args.clip_start, args.clip_end, len(views))
    # Initial ground speed (COLMAP units / s) from the first 2 s of the clip.
    early = t <= args.clip_start + 2.0
    speed0 = np.polyfit(t[early], ground_track[early] @ fwd, 1)[0]
    tee = ground_track[0] - fwd * speed0 * (args.clip_start - args.flight_start)
    far = ground_track[-1]
    length_colmap = (far - tee) @ fwd
    hole_m = args.hole_length_yd * YARD
    scale = hole_m / length_colmap

    # Rows of R map COLMAP vectors to hole-frame axes: x=right, y=up, z=-forward.
    R = np.stack([right, up, -fwd])
    T = np.eye(4)
    T[:3, :3] = scale * R
    T[:3, 3] = -scale * R @ tee

    def apply(p):
        return (T[:3, :3] @ p.T).T + T[:3, 3]

    cam_h = apply(centers)
    result = {
        "description": "COLMAP -> hole frame (metres, +Y up, -Z tee->green, origin at tee)",
        "matrix_row_major": T.tolist(),
        "scale_m_per_unit": scale,
        "scale_note": "approximate (+/-15%): from scorecard length and extrapolated drone track",
        "hole_length_m": hole_m,
        "camera_track_hole_frame": cam_h[:: max(1, len(cam_h) // 50)].round(2).tolist(),
        "camera_height_m": {"min": float(cam_h[:, 1].min()), "max": float(cam_h[:, 1].max()),
                            "median": float(np.median(cam_h[:, 1]))},
    }
    with open(args.out, "w") as f:
        json.dump(result, f, indent=1)
    print(json.dumps({k: v for k, v in result.items() if k != "camera_track_hole_frame"}, indent=1))


if __name__ == "__main__":
    main()
