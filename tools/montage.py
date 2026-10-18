#!/usr/bin/env python3
"""Compose a labelled 2x2 contact sheet from screenshots."""
import sys
from PIL import Image, ImageDraw, ImageFont

OUT = sys.argv[1] if len(sys.argv) > 1 else 'shots/montage.png'
PANELS = [
    ('shots/hud-menu.png', 'DEPLOY SCREEN'),
    ('shots/final-hero.png', 'CITY BLOCK  /  HIP FIRE'),
    ('shots/final-combat.png', 'CONTACT  /  AUTO FIRE'),
    ('shots/final-ads.png', 'ADS  /  HOLO SIGHT'),
]

CELL_W, CELL_H = 800, 450
canvas = Image.new('RGB', (CELL_W * 2, CELL_H * 2), (8, 9, 11))
draw = ImageDraw.Draw(canvas)

try:
    font = ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial Narrow.ttf', 18)
    font_small = ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial Narrow.ttf', 12)
except Exception:
    font = ImageFont.load_default()
    font_small = font

for i, (path, label) in enumerate(PANELS):
    img = Image.open(path).convert('RGB').resize((CELL_W, CELL_H), Image.LANCZOS)
    x = (i % 2) * CELL_W
    y = (i // 2) * CELL_H
    canvas.paste(img, (x, y))
    draw.rectangle([x, y, x + CELL_W - 1, y + CELL_H - 1], outline=(40, 42, 46), width=1)
    # label plate
    tw = draw.textlength(label, font=font)
    draw.rectangle([x + 22, y + CELL_H - 52, x + 38 + tw, y + CELL_H - 20], fill=(4, 5, 7))
    draw.rectangle([x + 22, y + CELL_H - 52, x + 25, y + CELL_H - 20], fill=(230, 178, 92))
    draw.text((x + 34, y + CELL_H - 46), label, fill=(235, 238, 240), font=font)
    draw.text((x + 24, y + 18), 'DEEPSEEK OF DUTY', fill=(235, 238, 240), font=font_small)

canvas.save(OUT)
print('wrote', OUT)
