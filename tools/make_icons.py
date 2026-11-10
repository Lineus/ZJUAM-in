# -*- coding: utf-8 -*-
"""Generate ZJUAMin toolbar icons (blue rounded square with a white Z)."""

import os

from PIL import Image, ImageDraw, ImageFont

BASE = 512
RADIUS = 118
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "icons")
FONT_PATH = r"C:\Windows\Fonts\segoeuib.ttf"


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def make_background():
    top = (0x2F, 0x8F, 0xE3)
    bottom = (0x08, 0x44, 0x8A)
    img = Image.new("RGB", (BASE, BASE))
    pixels = img.load()
    denom = 2 * (BASE - 1)
    for y in range(BASE):
        for x in range(BASE):
            t = (x + y) / denom
            pixels[x, y] = lerp(top, bottom, t)
    return img


def rounded_mask():
    mask = Image.new("L", (BASE, BASE), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle([0, 0, BASE - 1, BASE - 1], radius=RADIUS, fill=255)
    return mask


def add_sheen(img):
    sheen = Image.new("RGBA", (BASE, BASE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(sheen)
    for i in range(150):
        alpha = round(30 * (1 - i / 150))
        draw.ellipse(
            [64 - i * 2, -180 - i * 2, 480 + i * 2, 200 + i * 2],
            fill=(255, 255, 255, alpha),
        )
    return Image.alpha_composite(img.convert("RGBA"), sheen)


def add_letter(img):
    layer = Image.new("RGBA", (BASE, BASE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    font = ImageFont.truetype(FONT_PATH, 356)
    text = "Z"
    left, top, right, bottom = draw.textbbox((0, 0), text, font=font)
    x = (BASE - (right - left)) / 2 - left
    y = (BASE - (bottom - top)) / 2 - top

    draw.text((x, y + 9), text, font=font, fill=(4, 30, 62, 90))
    draw.text((x, y), text, font=font, fill=(255, 255, 255, 255))
    return Image.alpha_composite(img, layer)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    img = make_background()
    img = add_sheen(img)
    img = add_letter(img)
    img.putalpha(rounded_mask())

    for size in (16, 32, 48, 128):
        resized = img.resize((size, size), Image.LANCZOS)
        path = os.path.join(OUT_DIR, "icon%d.png" % size)
        resized.save(path)
        print("wrote", path)


if __name__ == "__main__":
    main()
