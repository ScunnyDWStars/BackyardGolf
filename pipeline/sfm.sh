#!/usr/bin/env bash
# Recover camera poses with COLMAP (CPU) and undistort to PINHOLE cameras.
# Usage: pipeline/sfm.sh <workdir>   (expects <workdir>/images, optional <workdir>/masks)
set -euo pipefail
WORK=$1
DB="$WORK/colmap.db"
rm -rf "$DB" "$WORK/sparse" "$WORK/undistorted"
mkdir -p "$WORK/sparse"

MASK_ARGS=()
[ -d "$WORK/masks" ] && MASK_ARGS=(--ImageReader.mask_path "$WORK/masks")

colmap feature_extractor --database_path "$DB" --image_path "$WORK/images" "${MASK_ARGS[@]}" \
  --ImageReader.single_camera 1 --ImageReader.camera_model SIMPLE_RADIAL \
  --SiftExtraction.use_gpu 0 --SiftExtraction.max_num_features 8192

colmap sequential_matcher --database_path "$DB" \
  --SiftMatching.use_gpu 0 --SequentialMatching.overlap 15 \
  --SequentialMatching.quadratic_overlap 1

colmap mapper --database_path "$DB" --image_path "$WORK/images" --output_path "$WORK/sparse" \
  --Mapper.ba_global_function_tolerance 1e-6

# Pick the largest reconstructed model.
BEST=$(for m in "$WORK"/sparse/*/; do
  n=$(colmap model_analyzer --path "$m" 2>&1 | awk '/Registered images/{print $NF}')
  echo "$n $m"; done | sort -rn | head -1 | awk '{print $2}')
echo "best model: $BEST"
colmap model_analyzer --path "$BEST"

colmap image_undistorter --image_path "$WORK/images" --input_path "$BEST" \
  --output_path "$WORK/undistorted" --output_type COLMAP
colmap model_converter --input_path "$WORK/undistorted/sparse" \
  --output_path "$WORK/undistorted/sparse" --output_type TXT
