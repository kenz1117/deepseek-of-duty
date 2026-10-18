#!/usr/bin/env python3
"""Sprint B contact sheet: CQB interiors + objective modes."""
from PIL import Image, ImageDraw, ImageFont

PANELS = [
    ('shots/interior-shop-inside.png', 'CQB  /  ALLEY WORKSHOP'),
    ('shots/interior-apartment.png', 'CQB  /  STREET APARTMENT'),
    ('shots/b-defend-close.png', 'MODE  /  DEFEND  ·  HOLD 60s'),
    ('shots/b-extract-workshop2.png', 'MODE  /  EXTRACT  ·  HOLD 8s'),
]
CELL_W, CELL_H = 800, 450
canvas = Image.new('RGB', (CELL_W * 2, CELL_H * 2), (8, 9, 11))
draw = ImageDraw.Draw(canvas)
try:
    font = ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial Narrow.ttf', 18)
except Exception:
    font = ImageFont.load_default()

for i, (path, label) in enumerate(PANELS):
    img = Image.open(path).convert('RGB').resize((CELL_W, CELL_H), Image.LANCZOS)
    x, y = (i % 2) * CELL_W, (i // 2) * CELL_H
    canvas.paste(img, (x, y))
    draw.rectangle([x, y, x + CELL_W - 1, y + CELL_H - 1], outline=(40, 42, 46), width=1)
    tw = draw.textlength(label, font=font)
    draw.rectangle([x + 22, y + CELL_H - 52, x + 38 + tw, y + CELL_H - 20], fill=(4, 5, 7))
    draw.rectangle([x + 22, y + CELL_H - 52, x + 25, y + CELL_H - 20], fill=(230, 178, 92))
    draw.text((x + 34, y + CELL_H - 46), label, fill=(235, 238, 240), font=font)

canvas.save('shots/sprintB-montage.png')
print('wrote shots/sprintB-montage.png')
