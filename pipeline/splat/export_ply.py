"""Write Gaussians in the standard 3DGS .ply layout (loadable by Spark, SuperSplat, etc.)."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import torch
from plyfile import PlyData, PlyElement


def save_ply(path: str | Path, params: dict[str, torch.Tensor]) -> None:
    means = params["means"].detach().cpu().numpy()
    n = len(means)
    sh0 = params["sh0"].detach().cpu().numpy()
    # f_rest is stored channel-major: all R coefficients, then G, then B.
    sh1 = params["sh1"].detach().cpu().numpy().transpose(0, 2, 1).reshape(n, -1)
    opac = params["opacities"].detach().cpu().numpy()[:, None]
    scales = params["scales"].detach().cpu().numpy()
    quats = params["quats"].detach().cpu().numpy()
    quats = quats / np.linalg.norm(quats, axis=1, keepdims=True)

    names = ["x", "y", "z", "nx", "ny", "nz", "f_dc_0", "f_dc_1", "f_dc_2"]
    names += [f"f_rest_{i}" for i in range(sh1.shape[1])]
    names += ["opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]
    data = np.concatenate([means, np.zeros_like(means), sh0, sh1, opac, scales, quats], axis=1)
    arr = np.empty(n, dtype=[(k, "f4") for k in names])
    arr[:] = list(map(tuple, data.astype(np.float32)))
    PlyData([PlyElement.describe(arr, "vertex")]).write(str(path))
