#!/usr/bin/env python3
"""Objective visual QA metrics for screenshots.

usage: python3 tools/analyze.py shots/hero.png [--json]

Reports the same hard numbers the blind critic uses:
  * % pixels <= 5 / 13 (dead black)
  * % sky band >= 242 (blown highlights)
  * mean |dx| detail energy in a few semantically useful regions
  * 3x3 mean luma grid
"""
import sys
import json
from PIL import Image, ImageStat

def detail_energy(img, box):
    crop = img.crop(box).convert('L')
    w, h = crop.size
    px = crop.load()
    if w < 3 or h < 3:
        return 0.0
    total = 0
    n = 0
    for y in range(0, h, 2):
        for x in range(1, w, 2):
            total += abs(px[x, y] - px[x - 1, y])
            n += 1
    return total / max(1, n)

def main(path):
    img = Image.open(path).convert('RGB')
    W, H = img.size
    g = img.convert('L')
    hist = g.histogram()
    total = W * H
    dead5 = sum(hist[0:6]) / total * 100
    dead13 = sum(hist[0:14]) / total * 100

    # sky band: top 22% of the frame (excluding HUD corners roughly)
    sky = g.crop((0, 0, W, int(H * 0.22)))
    sh = sky.histogram()
    st = sky.size[0] * sky.size[1]
    blown = sum(sh[243:]) / st * 100

    regions = {
        'sky': (0, 0, W, int(H * 0.20)),
        'facade_left': (0, int(H * 0.10), int(W * 0.32), int(H * 0.55)),
        'facade_right': (int(W * 0.70), int(H * 0.10), W, int(H * 0.55)),
        'road_center': (int(W * 0.28), int(H * 0.60), int(W * 0.72), int(H * 0.92)),
        'weapon': (int(W * 0.55), int(H * 0.55), W, H),
    }
    energy = {k: round(detail_energy(g, b), 2) for k, b in regions.items()}

    grid = []
    for gy in range(3):
        row = []
        for gx in range(3):
            box = (gx * W // 3, gy * H // 3, (gx + 1) * W // 3, (gy + 1) * H // 3)
            row.append(round(ImageStat.Stat(g.crop(box)).mean[0], 1))
        grid.append(row)

    out = {
        'file': path,
        'size': [W, H],
        'dead_black_le5_pct': round(dead5, 1),
        'dead_black_le13_pct': round(dead13, 1),
        'sky_blown_ge242_pct': round(blown, 1),
        'detail_energy': energy,
        'luma_grid': grid,
    }
    if '--json' in sys.argv:
        print(json.dumps(out, indent=2))
    else:
        print(f"file: {path}  {W}x{H}")
        print(f"dead black  <=5 : {dead5:5.1f}%   <=13: {dead13:5.1f}%")
        print(f"sky blown  >=242: {blown:5.1f}%")
        print("detail energy mean|dx|:")
        for k, v in energy.items():
            print(f"   {k:14s} {v}")
        print("luma grid:", grid)
    return out

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    main(sys.argv[1])
