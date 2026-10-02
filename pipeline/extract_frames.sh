#!/usr/bin/env bash
# Extract training frames from a flyover video.
# Usage: pipeline/extract_frames.sh <video> <workdir> [start_s] [end_s] [fps]
# Trim start/end to skip on-screen overlays (logos, yardage banners, end cards).
set -euo pipefail
VIDEO=$1
WORK=$2
START=${3:-0}
END=${4:-}
FPS=${5:-5}

mkdir -p "$WORK/images"
rm -f "$WORK"/images/*.png
ffmpeg -hide_banner -loglevel error -y -ss "$START" ${END:+-to "$END"} -i "$VIDEO" \
  -vf "fps=$FPS" "$WORK/images/f_%04d.png"
echo "extracted $(ls "$WORK/images" | wc -l) frames to $WORK/images"
