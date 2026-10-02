"""Minimal CPU 3D Gaussian Splatting: COLMAP I/O, projection, rasterization autograd glue."""

from __future__ import annotations

import math
import os
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image
from torch.utils.cpp_extension import load

_ext = None


def ext():
    global _ext
    if _ext is None:
        src = Path(__file__).with_name("rasterize.cpp")
        _ext = load(
            name="gs_cpu_rasterize",
            sources=[str(src)],
            extra_cflags=["-O3", "-fopenmp", "-march=native"],
            extra_ldflags=["-fopenmp"],
            verbose=False,
        )
    return _ext


# ---------------------------------------------------------------- COLMAP text I/O


@dataclass
class View:
    name: str
    R: torch.Tensor  # world -> camera rotation [3,3]
    t: torch.Tensor  # world -> camera translation [3]
    fx: float
    fy: float
    cx: float
    cy: float
    width: int
    height: int
    image: torch.Tensor  # [H,W,3] float in [0,1]

    @property
    def center(self) -> torch.Tensor:
        return -self.R.T @ self.t


def qvec_to_rotmat(q: np.ndarray) -> np.ndarray:
    w, x, y, z = q
    return np.array(
        [
            [1 - 2 * y * y - 2 * z * z, 2 * x * y - 2 * w * z, 2 * x * z + 2 * w * y],
            [2 * x * y + 2 * w * z, 1 - 2 * x * x - 2 * z * z, 2 * y * z - 2 * w * x],
            [2 * x * z - 2 * w * y, 2 * y * z + 2 * w * x, 1 - 2 * x * x - 2 * y * y],
        ]
    )


def load_colmap(root: str | os.PathLike) -> tuple[list[View], np.ndarray, np.ndarray]:
    """Load an undistorted COLMAP text model (PINHOLE cameras) plus its images."""
    root = Path(root)
    sparse = root / "sparse"
    cams = {}
    for line in (sparse / "cameras.txt").read_text().splitlines():
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        cid, model, w, h = int(parts[0]), parts[1], int(parts[2]), int(parts[3])
        params = [float(p) for p in parts[4:]]
        if model == "PINHOLE":
            fx, fy, cx, cy = params
        elif model == "SIMPLE_PINHOLE":
            fx, cx, cy = params
            fy = fx
        else:
            raise ValueError(f"expected undistorted PINHOLE cameras, got {model}")
        cams[cid] = (w, h, fx, fy, cx, cy)

    views = []
    lines = [l for l in (sparse / "images.txt").read_text().splitlines() if not l.startswith("#")]
    for i in range(0, len(lines), 2):
        parts = lines[i].split()
        if not parts:
            continue
        q = np.array([float(v) for v in parts[1:5]])
        t = np.array([float(v) for v in parts[5:8]])
        cid, name = int(parts[8]), parts[9]
        w, h, fx, fy, cx, cy = cams[cid]
        img = np.asarray(Image.open(root / "images" / name).convert("RGB"), dtype=np.float32) / 255.0
        views.append(
            View(
                name=name,
                R=torch.tensor(qvec_to_rotmat(q), dtype=torch.float32),
                t=torch.tensor(t, dtype=torch.float32),
                fx=fx, fy=fy, cx=cx, cy=cy, width=w, height=h,
                image=torch.from_numpy(img),
            )
        )
    views.sort(key=lambda v: v.name)

    xyz, rgb = [], []
    for line in (sparse / "points3D.txt").read_text().splitlines():
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        xyz.append([float(v) for v in parts[1:4]])
        rgb.append([int(v) for v in parts[4:7]])
    return views, np.array(xyz, dtype=np.float32), np.array(rgb, dtype=np.float32) / 255.0


def downscale(view: View, factor: int) -> View:
    if factor == 1:
        return view
    img = view.image.permute(2, 0, 1)[None]
    h, w = view.height // factor, view.width // factor
    img = F.interpolate(img, size=(h, w), mode="area")[0].permute(1, 2, 0).contiguous()
    sx, sy = w / view.width, h / view.height
    return View(view.name, view.R, view.t, view.fx * sx, view.fy * sy, view.cx * sx,
                view.cy * sy, w, h, img)


# ---------------------------------------------------------------- Gaussians

SH_C0 = 0.28209479177387814
SH_C1 = 0.4886025119029199


def quat_to_rotmat(q: torch.Tensor) -> torch.Tensor:
    q = F.normalize(q, dim=-1)
    w, x, y, z = q.unbind(-1)
    return torch.stack(
        [
            1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
            2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
            2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
        ],
        dim=-1,
    ).reshape(*q.shape[:-1], 3, 3)


def sh_to_rgb(sh0: torch.Tensor, sh1: torch.Tensor | None, dirs: torch.Tensor) -> torch.Tensor:
    """sh0 [N,3], sh1 [N,3(coeff),3(rgb)] in the standard 3DGS (y, z, x) basis order."""
    rgb = SH_C0 * sh0
    if sh1 is not None:
        x, y, z = dirs.unbind(-1)
        rgb = rgb - SH_C1 * y[:, None] * sh1[:, 0] + SH_C1 * z[:, None] * sh1[:, 1] \
            - SH_C1 * x[:, None] * sh1[:, 2]
    return (rgb + 0.5).clamp_min(0.0)


class _Rasterize(torch.autograd.Function):
    @staticmethod
    def forward(ctx, means2d, conics, colors, opacities, background, depths, radii, width, height):
        image, final_T, n_contrib, order, tile_start = ext().forward(
            means2d.contiguous(), conics.contiguous(), colors.contiguous(),
            opacities.contiguous(), depths.contiguous(), radii.contiguous(),
            background.contiguous(), width, height,
        )
        ctx.save_for_backward(means2d, conics, colors, opacities, background, final_T, n_contrib,
                              order, tile_start)
        ctx.size = (width, height)
        return image

    @staticmethod
    def backward(ctx, grad_image):
        means2d, conics, colors, opacities, background, final_T, n_contrib, order, tile_start = \
            ctx.saved_tensors
        width, height = ctx.size
        g = ext().backward(
            means2d.contiguous(), conics.contiguous(), colors.contiguous(),
            opacities.contiguous(), background.contiguous(), final_T, n_contrib, order,
            tile_start, grad_image.contiguous(), width, height,
        )
        return g[0], g[1], g[2], g[3], g[4], None, None, None, None


def render(params: dict[str, torch.Tensor], view: View, background: torch.Tensor,
           sh_degree: int = 1) -> dict[str, torch.Tensor]:
    """Render one view. Returns image [H,W,3], means2d (with .grad after backward) and the
    visible index set, so the trainer can accumulate densification statistics."""
    means = params["means"]
    p_cam = means @ view.R.T + view.t
    z = p_cam[:, 2]
    with torch.no_grad():
        # Frustum cull with a 30% guard band so Gaussians straddling the border still splat.
        x_ndc = p_cam[:, 0] / z.clamp_min(1e-6) * view.fx / view.width
        y_ndc = p_cam[:, 1] / z.clamp_min(1e-6) * view.fy / view.height
        vis = (z > 0.05) & (x_ndc.abs() < 0.8) & (y_ndc.abs() < 0.8)
        idx = vis.nonzero().squeeze(1)

    p = p_cam[idx]
    x, y, z = p.unbind(-1)
    scales = torch.exp(params["scales"][idx])
    Rq = quat_to_rotmat(params["quats"][idx])
    M = Rq * scales[:, None, :]
    cov3d = M @ M.transpose(1, 2)
    cov_cam = view.R @ cov3d @ view.R.T

    zero = torch.zeros_like(z)
    J = torch.stack(
        [view.fx / z, zero, -view.fx * x / z**2, zero, view.fy / z, -view.fy * y / z**2], dim=-1
    ).reshape(-1, 2, 3)
    cov2d = J @ cov_cam @ J.transpose(1, 2)
    a = cov2d[:, 0, 0] + 0.3
    b = cov2d[:, 0, 1]
    c = cov2d[:, 1, 1] + 0.3
    det = (a * c - b * b).clamp_min(1e-12)
    conics = torch.stack([c / det, -b / det, a / det], dim=-1)

    means2d = torch.stack([view.fx * x / z + view.cx, view.fy * y / z + view.cy], dim=-1)
    if means2d.requires_grad:
        means2d.retain_grad()

    with torch.no_grad():
        mid = 0.5 * (a + c)
        lam = mid + torch.sqrt((mid * mid - det).clamp_min(0.1))
        radii = torch.ceil(3.0 * torch.sqrt(lam)).to(torch.int32)
        on_screen = (means2d[:, 0] + radii > 0) & (means2d[:, 0] - radii < view.width) & \
            (means2d[:, 1] + radii > 0) & (means2d[:, 1] - radii < view.height)
        radii = torch.where(on_screen & (det > 1e-12), radii, torch.zeros_like(radii))

    dirs = F.normalize(means[idx] - view.center, dim=-1)
    sh1 = params["sh1"][idx] if sh_degree >= 1 else None
    colors = sh_to_rgb(params["sh0"][idx], sh1, dirs)
    opac = torch.sigmoid(params["opacities"][idx])

    image = _Rasterize.apply(means2d, conics, colors, opac, background, z.detach().contiguous(),
                             radii, view.width, view.height)
    return {"image": image, "means2d": means2d, "idx": idx, "radii": radii}


# ---------------------------------------------------------------- losses


def _gauss_window(size=11, sigma=1.5):
    g = torch.exp(-((torch.arange(size) - size // 2) ** 2) / (2 * sigma**2))
    g = g / g.sum()
    return (g[:, None] * g[None, :])[None, None].repeat(3, 1, 1, 1)


_WIN = _gauss_window()


def ssim(img1: torch.Tensor, img2: torch.Tensor) -> torch.Tensor:
    """img [H,W,3] in [0,1]."""
    a = img1.permute(2, 0, 1)[None]
    b = img2.permute(2, 0, 1)[None]
    mu1 = F.conv2d(a, _WIN, padding=5, groups=3)
    mu2 = F.conv2d(b, _WIN, padding=5, groups=3)
    s11 = F.conv2d(a * a, _WIN, padding=5, groups=3) - mu1**2
    s22 = F.conv2d(b * b, _WIN, padding=5, groups=3) - mu2**2
    s12 = F.conv2d(a * b, _WIN, padding=5, groups=3) - mu1 * mu2
    c1, c2 = 0.01**2, 0.03**2
    m = ((2 * mu1 * mu2 + c1) * (2 * s12 + c2)) / ((mu1**2 + mu2**2 + c1) * (s11 + s22 + c2))
    return m.mean()


def psnr(img1: torch.Tensor, img2: torch.Tensor) -> float:
    mse = F.mse_loss(img1.clamp(0, 1), img2).item()
    return 10 * math.log10(1.0 / max(mse, 1e-10))
