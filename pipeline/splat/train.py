"""Train a 3D Gaussian Splat on the CPU from an undistorted COLMAP reconstruction.

Usage:
  python pipeline/splat/train.py <colmap_undistorted_dir> <out_dir> [--iters 7000] [--downscale 1]

Follows the 3DGS recipe (Kerbl et al. 2023) scaled down for CPU: SH degree 1,
L1 + 0.2 D-SSIM, clone/split/prune densification and periodic opacity reset.
Every 8th view is held out for PSNR. Checkpoints and a .ply are written to out_dir.
"""

from __future__ import annotations

import argparse
import json
import math
import random
import time
from pathlib import Path

import numpy as np
import torch
from scipy.spatial import cKDTree

import gs
from align import fit_ground
from export_ply import save_ply

torch.set_num_threads(max(1, torch.get_num_threads()))


def init_params(xyz: np.ndarray, rgb: np.ndarray) -> dict[str, torch.Tensor]:
    n = len(xyz)
    dist, _ = cKDTree(xyz).query(xyz, k=4)
    mean_d = np.sqrt((dist[:, 1:] ** 2).mean(1)).clip(1e-4)
    return {
        "means": torch.tensor(xyz),
        "scales": torch.log(torch.tensor(mean_d, dtype=torch.float32))[:, None].repeat(1, 3),
        "quats": torch.tensor([1.0, 0, 0, 0]).repeat(n, 1),
        "opacities": torch.logit(torch.full((n,), 0.1)),
        "sh0": (torch.tensor(rgb) - 0.5) / gs.SH_C0,
        "sh1": torch.zeros(n, 3, 3),
    }


def seed_ground(views, xyz: np.ndarray, n: int, seed: int = 0) -> tuple[np.ndarray, np.ndarray]:
    """Scatter points over the fitted ground plane along the drone track.

    Low-resolution grass gives SfM almost no features, so the fairway in front of the
    camera starts empty. Seeds are coloured from the frame that sees them closest."""
    rng = np.random.default_rng(seed)
    centers = np.stack([v.center.numpy() for v in views])
    image_up = np.stack([-v.R.numpy()[1] for v in views])
    up, origin = fit_ground(centers, image_up, xyz)
    ground_track = centers - ((centers - origin) @ up)[:, None] * up
    fwd = ground_track[-1] - ground_track[0]
    length = np.linalg.norm(fwd)
    fwd /= length
    right = np.cross(fwd, up)
    a = rng.uniform(-0.05, 1.15, n) * length
    b = rng.uniform(-0.3, 0.3, n) * length
    pts = ground_track[0] + a[:, None] * fwd + b[:, None] * right

    colors = np.full((n, 3), np.nan, dtype=np.float32)
    best = np.full(n, np.inf)
    for v in views:
        R, t = v.R.numpy(), v.t.numpy()
        pc = pts @ R.T + t
        z = pc[:, 2]
        u = v.fx * pc[:, 0] / np.maximum(z, 1e-6) + v.cx
        w = v.fy * pc[:, 1] / np.maximum(z, 1e-6) + v.cy
        ok = (z > 0) & (u >= 0) & (u < v.width) & (w >= 0) & (w < v.height) & (z < best)
        img = v.image.numpy()
        colors[ok] = img[w[ok].astype(int), u[ok].astype(int)]
        best[ok] = z[ok]
    seen = ~np.isnan(colors[:, 0])
    print(f"seeded {seen.sum()} ground points ({n - seen.sum()} unseen dropped)")
    return pts[seen].astype(np.float32), colors[seen]


class Trainer:
    def __init__(self, params, extent: float, iters: int):
        self.extent = extent
        self.iters = iters
        self.params = {k: torch.nn.Parameter(v.contiguous()) for k, v in params.items()}
        self.background = torch.nn.Parameter(torch.tensor([0.85, 0.87, 0.9]))
        self.lr = {
            "means": 1.6e-4 * extent, "scales": 5e-3, "quats": 1e-3, "opacities": 5e-2,
            "sh0": 2.5e-3, "sh1": 2.5e-3 / 20,
        }
        self.opt = torch.optim.Adam(
            [{"params": [p], "lr": self.lr[k], "name": k} for k, p in self.params.items()]
            + [{"params": [self.background], "lr": 1e-3, "name": "bg"}],
            eps=1e-15,
        )
        self.reset_stats()

    def reset_stats(self):
        n = len(self.params["means"])
        self.grad_accum = torch.zeros(n)
        self.grad_count = torch.zeros(n)
        self.max_radii = torch.zeros(n)

    def set_means_lr(self, step: int):
        t = min(step / self.iters, 1.0)
        lr = math.exp((1 - t) * math.log(1.6e-4) + t * math.log(1.6e-6)) * self.extent
        for g in self.opt.param_groups:
            if g["name"] == "means":
                g["lr"] = lr

    # -- optimizer surgery for densification -------------------------------------------

    def _replace(self, mutate):
        """mutate(name, tensor, is_state) -> new tensor. Keeps Adam moments aligned."""
        for g in self.opt.param_groups:
            name = g["name"]
            if name == "bg":
                continue
            old = g["params"][0]
            state = self.opt.state.pop(old, None)
            new = torch.nn.Parameter(mutate(name, old.data, False).contiguous())
            if state:
                state["exp_avg"] = mutate(name, state["exp_avg"], True).contiguous()
                state["exp_avg_sq"] = mutate(name, state["exp_avg_sq"], True).contiguous()
                self.opt.state[new] = state
            g["params"][0] = new
            self.params[name] = new

    def densify(self, grad_threshold=0.0002, min_opacity=0.005, prune_big=False):
        p = self.params
        grads = self.grad_accum / self.grad_count.clamp_min(1)
        max_scale = torch.exp(p["scales"].data).max(1).values
        dense_limit = 0.01 * self.extent
        hot = grads >= grad_threshold
        clone = hot & (max_scale <= dense_limit)
        split = hot & (max_scale > dense_limit)

        # Split: two samples drawn from each large Gaussian, scaled down by 1.6.
        n_split = int(split.sum())
        with torch.no_grad():
            sc = torch.exp(p["scales"].data[split]).repeat(2, 1)
            rot = gs.quat_to_rotmat(p["quats"].data[split]).repeat(2, 1, 1)
            offsets = (rot @ (torch.randn_like(sc) * sc)[..., None])[..., 0]

        def grow(name, t, is_state):
            extra = [t[clone]]
            if is_state:
                extra.append(torch.zeros_like(t[split]).repeat(2, *[1] * (t.dim() - 1)))
            elif name == "means":
                extra.append(t[split].repeat(2, 1) + offsets)
            elif name == "scales":
                extra.append(torch.log(torch.exp(t[split]) / 1.6).repeat(2, 1))
            else:
                extra.append(t[split].repeat(2, *[1] * (t.dim() - 1)))
            if is_state:
                extra[0] = torch.zeros_like(extra[0])
            return torch.cat([t] + extra)

        self._replace(grow)
        n = len(self.params["means"])
        # Remove the originals that were split, plus transparent / oversized ones.
        keep = torch.ones(n, dtype=torch.bool)
        keep[: len(split)][split] = False
        with torch.no_grad():
            keep &= torch.sigmoid(self.params["opacities"].data) > min_opacity
            if prune_big:
                keep &= torch.exp(self.params["scales"].data).max(1).values < 0.1 * self.extent
        self._replace(lambda name, t, is_state: t[keep])
        self.reset_stats()
        return int(clone.sum()), n_split, int((~keep).sum())

    def reset_opacity(self):
        cap = torch.logit(torch.tensor(0.01))

        def fn(name, t, is_state):
            if name != "opacities":
                return t
            return torch.zeros_like(t) if is_state else torch.minimum(t, cap)

        self._replace(fn)


def evaluate(trainer: Trainer, views) -> float:
    with torch.no_grad():
        scores = [gs.psnr(gs.render(trainer.params, v, trainer.background)["image"], v.image)
                  for v in views]
    return float(np.mean(scores))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("data")
    ap.add_argument("out")
    ap.add_argument("--iters", type=int, default=7000)
    ap.add_argument("--downscale", type=int, default=1)
    ap.add_argument("--densify-until", type=int, default=None)
    ap.add_argument("--max-gaussians", type=int, default=600_000)
    ap.add_argument("--ground-seeds", type=int, default=40_000)
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    views, xyz, rgb = gs.load_colmap(args.data)
    views = [gs.downscale(v, args.downscale) for v in views]
    test = views[::8]
    train = [v for i, v in enumerate(views) if i % 8]
    centers = torch.stack([v.center for v in views])
    extent = float((centers - centers.mean(0)).norm(dim=1).max()) * 1.1
    print(f"{len(train)} train / {len(test)} test views, {len(xyz)} SfM points, "
          f"extent {extent:.3f}, {views[0].width}x{views[0].height}", flush=True)

    if args.ground_seeds:
        gp, gc = seed_ground(views, xyz, args.ground_seeds)
        xyz, rgb = np.concatenate([xyz, gp]), np.concatenate([rgb, gc])
    trainer = Trainer(init_params(xyz, rgb), extent, args.iters)
    densify_until = args.densify_until or args.iters // 2
    log = []
    order: list = []
    t0 = time.time()
    for step in range(1, args.iters + 1):
        trainer.set_means_lr(step)
        if not order:
            order = random.sample(train, len(train))
        view = order.pop()

        out_r = gs.render(trainer.params, view, trainer.background)
        img = out_r["image"]
        l1 = (img - view.image).abs().mean()
        loss = 0.8 * l1 + 0.2 * (1 - gs.ssim(img, view.image))
        trainer.opt.zero_grad(set_to_none=True)
        loss.backward()
        trainer.opt.step()

        with torch.no_grad():
            idx, radii = out_r["idx"], out_r["radii"]
            seen = radii > 0
            g = out_r["means2d"].grad.clone()
            g[:, 0] *= view.width / 2
            g[:, 1] *= view.height / 2
            trainer.grad_accum[idx[seen]] += g[seen].norm(dim=1)
            trainer.grad_count[idx[seen]] += 1
            trainer.max_radii[idx[seen]] = torch.maximum(trainer.max_radii[idx[seen]],
                                                         radii[seen].float())

            n = len(trainer.params["means"])
            if 500 <= step <= densify_until and step % 100 == 0 and n < args.max_gaussians:
                c, s, p = trainer.densify(prune_big=step > 3000)
                print(f"  densify @ {step}: +{c} clone, +{s} split, -{p} prune -> "
                      f"{len(trainer.params['means'])}", flush=True)
            elif step > densify_until and step % 500 == 0:
                trainer.densify(grad_threshold=float("inf"))  # prune only
            if step % 3000 == 0 and step <= densify_until:
                trainer.reset_opacity()

        if step % 50 == 0:
            el = time.time() - t0
            print(f"step {step}/{args.iters} loss {loss.item():.4f} "
                  f"n={len(trainer.params['means'])} {el / step:.2f}s/it "
                  f"eta {el / step * (args.iters - step) / 60:.0f}min", flush=True)
        if step % 500 == 0 or step == args.iters:
            score = evaluate(trainer, test)
            log.append({"step": step, "test_psnr": score, "n": len(trainer.params["means"])})
            print(f"== step {step}: test PSNR {score:.2f} dB", flush=True)
            torch.save({k: v.data for k, v in trainer.params.items()}
                       | {"background": trainer.background.data, "step": step},
                       out / "ckpt.pt")
            save_ply(out / "splat.ply", {k: v.data for k, v in trainer.params.items()})
            (out / "train_log.json").write_text(json.dumps(log, indent=1))


if __name__ == "__main__":
    main()
