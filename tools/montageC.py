#!/usr/bin/env python3
"""Sprint C contact sheet + AO on/off comparison."""
from PIL import Image, ImageDraw, ImageFont

def sheet(panels, out, cols=2):
    cw, ch = 800, 450
    rows = (len(panels) + cols - 1) // cols
    canvas = Image.new('RGB', (cw * cols, ch * rows), (8, 9, 11))
    draw = ImageDraw.Draw(canvas)
    try:
        font = ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial Narrow.ttf', 18)
    except Exception:
        font = ImageFont.load_default()
    for i, (path, label) in enumerate(panels):
        img = Image.open(path).convert('RGB').resize((cw, ch), Image.LANCZOS)
        x, y = (i % cols) * cw, (i // cols) * ch
        canvas.paste(img, (x, y))
        draw.rectangle([x, y, x + cw - 1, y + ch - 1], outline=(40, 42, 46), width=1)
        tw = draw.textlength(label, font=font)
        draw.rectangle([x + 22, y + ch - 52, x + 38 + tw, y + ch - 20], fill=(4, 5, 7))
        draw.rectangle([x + 22, y + ch - 52, x + 25, y + ch - 20], fill=(230, 178, 92))
        draw.text((x + 34, y + ch - 46), label, fill=(235, 238, 240), font=font)
    canvas.save(out)
    print('wrote', out)

sheet([
    ('shots/c-ssao-clean.png', 'SSAO  /  HALF-RES  /  STREET'),
    ('shots/atlas-hand5-zoom.png', 'ATLAS  /  1K PBR  /  HAND'),
    ('shots/rag-hero.png', 'RAGDOLL  /  HEADSHOT  /  SETTLED'),
    ('shots/c-ssao-interior.png', 'SSAO  /  CONTACT  /  INTERIOR'),
], 'shots/sprintC-montage.png')

sheet([
    ('shots/c-ssao-off.png', 'AO OFF'),
    ('shots/c-ssao-clean.png', 'AO ON  /  HALF-RES'),
], 'shots/sprintC-ao-compare.png')
