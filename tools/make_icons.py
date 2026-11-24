"""Иконки PWA (assets/icons/*.png): глаз с розовым нижним веком и каплей. Нужен Pillow."""
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / 'assets' / 'icons'
BRAND = (122, 31, 43)


def icon(size, maskable=False):
    im = Image.new('RGB', (size, size), BRAND if maskable else (255, 255, 255))
    d = ImageDraw.Draw(im)
    s = size / 512
    if not maskable:
        d.rounded_rectangle([0, 0, size - 1, size - 1], radius=int(110 * s), fill=BRAND)
    pad = 0.18 if maskable else 0.1
    cx, cy = size / 2, size * 0.46
    w, h = size * (0.5 - pad) * 1.6, size * 0.22
    d.ellipse([cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2], fill=(255, 255, 255))
    r = h * 0.38
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(60, 40, 30))
    d.ellipse([cx - r * 0.45, cy - r * 0.45, cx + r * 0.45, cy + r * 0.45], fill=(10, 10, 10))
    d.arc([cx - w / 2, cy - h * 0.2, cx + w / 2, cy + h * 1.0], start=20, end=160, fill=(240, 140, 140),
          width=max(3, int(22 * s)))
    dy = size * 0.74
    d.ellipse([cx - 24 * s, dy - 10 * s, cx + 24 * s, dy + 38 * s], fill=(255, 210, 210))
    d.polygon([(cx - 22 * s, dy + 8 * s), (cx + 22 * s, dy + 8 * s), (cx, dy - 34 * s)], fill=(255, 210, 210))
    return im


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    icon(192).save(OUT / 'icon-192.png')
    icon(512).save(OUT / 'icon-512.png')
    icon(512, maskable=True).save(OUT / 'maskable-512.png')
