"""Check the C++ CPU rasterizer against a dense PyTorch reference (forward + gradients)."""
import sys
from pathlib import Path

import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "splat"))
import gs  # noqa: E402


def dense_reference(means2d, conics, colors, opac, bg, depths, W, H):
    order = torch.argsort(depths)
    means2d, conics, colors, opac = means2d[order], conics[order], colors[order], opac[order]
    ys, xs = torch.meshgrid(torch.arange(H) + 0.5, torch.arange(W) + 0.5, indexing="ij")
    pix = torch.stack([xs.reshape(-1), ys.reshape(-1)], -1)
    d = means2d[None] - pix[:, None]
    power = -0.5 * (conics[:, 0] * d[..., 0] ** 2 + conics[:, 2] * d[..., 1] ** 2) \
        - conics[:, 1] * d[..., 0] * d[..., 1]
    alpha = torch.clamp(opac * torch.exp(power), max=0.99)
    alpha = torch.where((power <= 0) & (alpha >= 1 / 255), alpha, torch.zeros_like(alpha))
    T = torch.cumprod(torch.cat([torch.ones_like(alpha[:, :1]), 1 - alpha[:, :-1]], 1), 1)
    w = alpha * T
    img = w @ colors + (T[:, -1] * (1 - alpha[:, -1]))[:, None] * bg
    return img.reshape(H, W, 3)


def test_matches_dense_reference():
    torch.manual_seed(0)
    W, H, N = 40, 24, 30
    means2d = (torch.rand(N, 2) * torch.tensor([W, H])).requires_grad_()
    s = torch.rand(N) * 4 + 1
    conics = torch.stack([1 / s**2, torch.randn(N) * 0.01, 1 / (s * 1.3) ** 2], -1).requires_grad_()
    colors = torch.rand(N, 3).requires_grad_()
    opac = (torch.rand(N) * 0.6 + 0.1).requires_grad_()
    bg = torch.rand(3).requires_grad_()
    depths = torch.rand(N)
    radii = torch.full((N,), 20, dtype=torch.int32)
    target = torch.rand(H, W, 3)

    out = gs._Rasterize.apply(means2d, conics, colors, opac, bg, depths, radii, W, H)
    ((out - target) ** 2).sum().backward()
    grads = [t.grad.clone() for t in (means2d, conics, colors, opac, bg)]
    for t in (means2d, conics, colors, opac, bg):
        t.grad = None

    ref = dense_reference(means2d, conics, colors, opac, bg, depths, W, H)
    ((ref - target) ** 2).sum().backward()
    ref_grads = [t.grad for t in (means2d, conics, colors, opac, bg)]

    assert torch.allclose(out, ref, atol=1e-4), (out - ref).abs().max()
    for name, g, r in zip(["means2d", "conics", "colors", "opac", "bg"], grads, ref_grads):
        err = (g - r).abs().max() / r.abs().max().clamp_min(1e-8)
        assert err < 1e-3, f"{name}: rel err {err:.2e}"


if __name__ == "__main__":
    test_matches_dense_reference()
    print("rasterizer forward/backward match dense reference")
