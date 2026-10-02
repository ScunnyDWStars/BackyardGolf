// CPU tile rasterizer for 3D Gaussian Splatting, with an analytic backward pass.
//
// Mirrors the reference 3DGS CUDA rasterizer (Kerbl et al. 2023): Gaussians are
// binned into 16x16 pixel tiles, sorted front-to-back by depth within each tile,
// and alpha-composited per pixel. Projection, SH evaluation and everything else
// that autograd handles well stays in PyTorch; only the per-pixel compositing
// loop lives here, parallelised over tiles with OpenMP.
//
// Conventions: pixel (px, py) has its centre at (px + 0.5, py + 0.5).
// conic = (a, b, c) is the inverse 2D covariance; the Gaussian falloff is
//   power = -0.5 * (a dx^2 + c dy^2) - b dx dy,  d = mean2d - pixel_centre.

#include <torch/extension.h>
#include <omp.h>

#include <algorithm>
#include <cmath>
#include <vector>

namespace {

constexpr int kTile = 16;
constexpr float kMinAlpha = 1.0f / 255.0f;
constexpr float kMaxAlpha = 0.99f;
constexpr float kMinT = 1e-4f;

struct Binning {
  std::vector<int32_t> order;       // gaussian ids, grouped by tile, front to back
  std::vector<int64_t> tile_start;  // [num_tiles + 1] offsets into order
};

Binning bin_gaussians(const float* means, const float* depths, const int32_t* radii,
                      int64_t n, int width, int height) {
  const int tiles_x = (width + kTile - 1) / kTile;
  const int tiles_y = (height + kTile - 1) / kTile;
  const int num_tiles = tiles_x * tiles_y;

  // Count pairs per tile, then scatter (counting sort by tile).
  std::vector<int64_t> counts(num_tiles + 1, 0);
  auto rect = [&](int64_t g, int& x0, int& y0, int& x1, int& y1) {
    const float mx = means[2 * g], my = means[2 * g + 1];
    const int r = radii[g];
    x0 = std::max(0, std::min(tiles_x, int(std::floor((mx - r) / kTile))));
    y0 = std::max(0, std::min(tiles_y, int(std::floor((my - r) / kTile))));
    x1 = std::max(0, std::min(tiles_x, int(std::floor((mx + r) / kTile)) + 1));
    y1 = std::max(0, std::min(tiles_y, int(std::floor((my + r) / kTile)) + 1));
  };
  for (int64_t g = 0; g < n; ++g) {
    if (radii[g] <= 0) continue;
    int x0, y0, x1, y1;
    rect(g, x0, y0, x1, y1);
    for (int ty = y0; ty < y1; ++ty)
      for (int tx = x0; tx < x1; ++tx) counts[ty * tiles_x + tx + 1]++;
  }
  for (int t = 0; t < num_tiles; ++t) counts[t + 1] += counts[t];

  Binning b;
  b.tile_start = counts;
  b.order.resize(counts[num_tiles]);
  std::vector<int64_t> cursor(counts.begin(), counts.end() - 1);
  for (int64_t g = 0; g < n; ++g) {
    if (radii[g] <= 0) continue;
    int x0, y0, x1, y1;
    rect(g, x0, y0, x1, y1);
    for (int ty = y0; ty < y1; ++ty)
      for (int tx = x0; tx < x1; ++tx) b.order[cursor[ty * tiles_x + tx]++] = int32_t(g);
  }

#pragma omp parallel for schedule(dynamic, 4)
  for (int t = 0; t < num_tiles; ++t) {
    std::sort(b.order.begin() + b.tile_start[t], b.order.begin() + b.tile_start[t + 1],
              [&](int32_t i, int32_t j) { return depths[i] < depths[j]; });
  }
  return b;
}

inline bool eval_alpha(const float* means, const float* conics, const float* opac, int32_t g,
                       float px, float py, float& alpha, float& G, float& dx, float& dy) {
  dx = means[2 * g] - px;
  dy = means[2 * g + 1] - py;
  const float a = conics[3 * g], b = conics[3 * g + 1], c = conics[3 * g + 2];
  const float power = -0.5f * (a * dx * dx + c * dy * dy) - b * dx * dy;
  if (power > 0.0f) return false;
  G = std::exp(power);
  alpha = std::min(kMaxAlpha, opac[g] * G);
  return alpha >= kMinAlpha;
}

}  // namespace

// Returns (image [H,W,3], final_T [H,W], n_contrib [H,W] int32, order, tile_start).
std::vector<torch::Tensor> rasterize_forward(torch::Tensor means2d, torch::Tensor conics,
                                             torch::Tensor colors, torch::Tensor opacities,
                                             torch::Tensor depths, torch::Tensor radii,
                                             torch::Tensor background, int64_t width,
                                             int64_t height) {
  const int64_t n = means2d.size(0);
  const float* M = means2d.data_ptr<float>();
  const float* C = conics.data_ptr<float>();
  const float* col = colors.data_ptr<float>();
  const float* op = opacities.data_ptr<float>();
  const float* bg = background.data_ptr<float>();

  Binning b = bin_gaussians(M, depths.data_ptr<float>(), radii.data_ptr<int32_t>(), n,
                            int(width), int(height));

  auto image = torch::zeros({height, width, 3}, torch::kFloat32);
  auto final_T = torch::zeros({height, width}, torch::kFloat32);
  auto n_contrib = torch::zeros({height, width}, torch::kInt32);
  float* img = image.data_ptr<float>();
  float* fT = final_T.data_ptr<float>();
  int32_t* nc = n_contrib.data_ptr<int32_t>();

  const int tiles_x = (int(width) + kTile - 1) / kTile;
  const int num_tiles = int(b.tile_start.size()) - 1;

#pragma omp parallel for schedule(dynamic, 2)
  for (int t = 0; t < num_tiles; ++t) {
    const int tx = t % tiles_x, ty = t / tiles_x;
    const int64_t s = b.tile_start[t], e = b.tile_start[t + 1];
    for (int py = ty * kTile; py < std::min<int>(int(height), (ty + 1) * kTile); ++py) {
      for (int px = tx * kTile; px < std::min<int>(int(width), (tx + 1) * kTile); ++px) {
        const float fx = px + 0.5f, fy = py + 0.5f;
        float T = 1.0f, r = 0.f, g_ = 0.f, bl = 0.f;
        int32_t last = 0;
        for (int64_t k = s; k < e; ++k) {
          const int32_t g = b.order[k];
          float alpha, G, dx, dy;
          if (!eval_alpha(M, C, op, g, fx, fy, alpha, G, dx, dy)) continue;
          const float nextT = T * (1.0f - alpha);
          if (nextT < kMinT) break;
          const float w = alpha * T;
          r += col[3 * g] * w;
          g_ += col[3 * g + 1] * w;
          bl += col[3 * g + 2] * w;
          T = nextT;
          last = int32_t(k - s + 1);
        }
        const int64_t p = int64_t(py) * width + px;
        img[3 * p] = r + T * bg[0];
        img[3 * p + 1] = g_ + T * bg[1];
        img[3 * p + 2] = bl + T * bg[2];
        fT[p] = T;
        nc[p] = last;
      }
    }
  }

  auto order = torch::from_blob(b.order.data(), {int64_t(b.order.size())}, torch::kInt32).clone();
  auto tile_start =
      torch::from_blob(b.tile_start.data(), {int64_t(b.tile_start.size())}, torch::kInt64).clone();
  return {image, final_T, n_contrib, order, tile_start};
}

// Returns grads for (means2d, conics, colors, opacities, background).
std::vector<torch::Tensor> rasterize_backward(torch::Tensor means2d, torch::Tensor conics,
                                              torch::Tensor colors, torch::Tensor opacities,
                                              torch::Tensor background, torch::Tensor final_T,
                                              torch::Tensor n_contrib, torch::Tensor order,
                                              torch::Tensor tile_start, torch::Tensor grad_image,
                                              int64_t width, int64_t height) {
  const int64_t n = means2d.size(0);
  const float* M = means2d.data_ptr<float>();
  const float* C = conics.data_ptr<float>();
  const float* col = colors.data_ptr<float>();
  const float* op = opacities.data_ptr<float>();
  const float* bg = background.data_ptr<float>();
  const float* fT = final_T.data_ptr<float>();
  const int32_t* nc = n_contrib.data_ptr<int32_t>();
  const int32_t* ord = order.data_ptr<int32_t>();
  const int64_t* ts = tile_start.data_ptr<int64_t>();
  const float* dI = grad_image.contiguous().data_ptr<float>();

  const int nthreads = omp_get_max_threads();
  // Per-thread accumulators avoid atomics: [threads, n, 9] = mean(2) conic(3) color(3) opacity(1)
  std::vector<float> acc(size_t(nthreads) * n * 9, 0.0f);
  std::vector<float> acc_bg(size_t(nthreads) * 3, 0.0f);

  const int tiles_x = (int(width) + kTile - 1) / kTile;
  const int num_tiles = int(tile_start.size(0)) - 1;

#pragma omp parallel for schedule(dynamic, 2)
  for (int t = 0; t < num_tiles; ++t) {
    float* A = acc.data() + size_t(omp_get_thread_num()) * n * 9;
    float* Abg = acc_bg.data() + size_t(omp_get_thread_num()) * 3;
    const int tx = t % tiles_x, ty = t / tiles_x;
    const int64_t s = ts[t];
    for (int py = ty * kTile; py < std::min<int>(int(height), (ty + 1) * kTile); ++py) {
      for (int px = tx * kTile; px < std::min<int>(int(width), (tx + 1) * kTile); ++px) {
        const int64_t p = int64_t(py) * width + px;
        const float fx = px + 0.5f, fy = py + 0.5f;
        const float Tf = fT[p];
        const float dpix[3] = {dI[3 * p], dI[3 * p + 1], dI[3 * p + 2]};
        Abg[0] += Tf * dpix[0];
        Abg[1] += Tf * dpix[1];
        Abg[2] += Tf * dpix[2];
        const float bg_dot = bg[0] * dpix[0] + bg[1] * dpix[1] + bg[2] * dpix[2];

        float T = Tf;
        float accum[3] = {0.f, 0.f, 0.f};
        float last_alpha = 0.f, last_col[3] = {0.f, 0.f, 0.f};
        for (int64_t k = s + nc[p] - 1; k >= s; --k) {
          const int32_t g = ord[k];
          float alpha, G, dx, dy;
          if (!eval_alpha(M, C, op, g, fx, fy, alpha, G, dx, dy)) continue;
          T = T / (1.0f - alpha);
          const float w = alpha * T;
          float dL_dalpha = 0.f;
          float* Ag = A + size_t(g) * 9;
          for (int ch = 0; ch < 3; ++ch) {
            const float c = col[3 * g + ch];
            accum[ch] = last_alpha * last_col[ch] + (1.f - last_alpha) * accum[ch];
            last_col[ch] = c;
            dL_dalpha += (c - accum[ch]) * dpix[ch];
            Ag[5 + ch] += w * dpix[ch];
          }
          dL_dalpha *= T;
          last_alpha = alpha;
          dL_dalpha += (-Tf / (1.f - alpha)) * bg_dot;
          if (op[g] * G > kMaxAlpha) continue;  // clamped: no gradient through G or opacity

          const float dL_dG = op[g] * dL_dalpha;
          const float gdx = G * dx, gdy = G * dy;
          const float a = C[3 * g], b = C[3 * g + 1], c = C[3 * g + 2];
          Ag[0] += dL_dG * (-gdx * a - gdy * b);
          Ag[1] += dL_dG * (-gdy * c - gdx * b);
          Ag[2] += -0.5f * gdx * dx * dL_dG;
          Ag[3] += -gdx * dy * dL_dG;
          Ag[4] += -0.5f * gdy * dy * dL_dG;
          Ag[8] += G * dL_dalpha;
        }
      }
    }
  }

  auto g_means = torch::zeros({n, 2}, torch::kFloat32);
  auto g_conics = torch::zeros({n, 3}, torch::kFloat32);
  auto g_colors = torch::zeros({n, 3}, torch::kFloat32);
  auto g_opac = torch::zeros({n}, torch::kFloat32);
  auto g_bg = torch::zeros({3}, torch::kFloat32);
  float* gm = g_means.data_ptr<float>();
  float* gc = g_conics.data_ptr<float>();
  float* gcol = g_colors.data_ptr<float>();
  float* go = g_opac.data_ptr<float>();

#pragma omp parallel for schedule(static)
  for (int64_t g = 0; g < n; ++g) {
    for (int th = 0; th < nthreads; ++th) {
      const float* Ag = acc.data() + (size_t(th) * n + g) * 9;
      gm[2 * g] += Ag[0];
      gm[2 * g + 1] += Ag[1];
      gc[3 * g] += Ag[2];
      gc[3 * g + 1] += Ag[3];
      gc[3 * g + 2] += Ag[4];
      gcol[3 * g] += Ag[5];
      gcol[3 * g + 1] += Ag[6];
      gcol[3 * g + 2] += Ag[7];
      go[g] += Ag[8];
    }
  }
  for (int th = 0; th < nthreads; ++th)
    for (int ch = 0; ch < 3; ++ch) g_bg.data_ptr<float>()[ch] += acc_bg[th * 3 + ch];
  return {g_means, g_conics, g_colors, g_opac, g_bg};
}

PYBIND11_MODULE(TORCH_EXTENSION_NAME, m) {
  m.def("forward", &rasterize_forward, "3DGS tile rasterizer forward (CPU)");
  m.def("backward", &rasterize_backward, "3DGS tile rasterizer backward (CPU)");
}
