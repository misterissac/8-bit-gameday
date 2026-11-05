"""Render public/og.png — the 1200x630 link-preview card.

Run from anywhere: `python3 frontend/scripts/make-og-image.py`. Needs Pillow,
and the DIN faces are the macOS system fonts named below.
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent.parent / "public" / "og.png"

W, H = 1200, 630
BG = (10, 14, 21)
GRID = (15, 21, 31)
AMBER = (230, 168, 23)
WHITE = (245, 247, 250)
MUTED = (155, 166, 180)
INFIELD = (19, 27, 41)

CONDENSED = "/System/Library/Fonts/Supplemental/DIN Condensed Bold.ttf"
ALTERNATE = "/System/Library/Fonts/Supplemental/DIN Alternate Bold.ttf"


def tracked(draw, xy, text, font, fill, spacing=0):
    x, y = xy
    for ch in text:
        draw.text((x, y), ch, font=font, fill=fill)
        x += draw.textlength(ch, font=font) + spacing
    return x


img = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(img)

# Faint 8-bit grid so the background reads as pixels, not a flat panel.
for x in range(0, W, 40):
    d.line([(x, 0), (x, H)], fill=GRID)
for y in range(0, H, 40):
    d.line([(0, y), (W, y)], fill=GRID)

# --- copy ---------------------------------------------------------------
tracked(d, (72, 132), "LIVE MLB  /  3D PLAYBACK", ImageFont.truetype(ALTERNATE, 26),
        AMBER, spacing=3)
d.text((66, 168), "8-BIT", font=ImageFont.truetype(CONDENSED, 120), fill=AMBER)
d.text((66, 258), "PLAY-BY-PLAY", font=ImageFont.truetype(CONDENSED, 120), fill=WHITE)

d.rectangle([72, 430, 132, 436], fill=AMBER)
d.text((72, 452), "Every pitch replayed in pixel-perfect 3D —",
       font=ImageFont.truetype(ALTERNATE, 30), fill=MUTED)
d.text((72, 494), "real trajectories, live scorebug, instant replay.",
       font=ImageFont.truetype(ALTERNATE, 30), fill=MUTED)

# --- pixel ballpark, top-down, home plate at the bottom ------------------
cx, cy, block, n = 930, 315, 13, 9


def cell(dx, dy, fill):
    x = cx + dx * block
    y = cy + dy * block
    d.rectangle([x, y, x + block - 1, y + block - 1], fill=fill)


# Bags sit just inside each corner so the diamond's outline stays unbroken.
bases = {(0, -n + 1), (n - 1, 0), (-n + 1, 0), (0, n - 2), (0, n - 1)}

for dy in range(-n, n + 1):
    for dx in range(-n, n + 1):
        dist = abs(dx) + abs(dy)
        if (dx, dy) in bases:
            cell(dx, dy, WHITE)
        elif dist == n:
            cell(dx, dy, AMBER)
        elif dist < n:
            cell(dx, dy, INFIELD)

# Mound.
for dx in (0, 1):
    for dy in (0, 1):
        cell(dx, dy, AMBER)

img.save(OUT, optimize=True)
print(f"wrote {OUT}")
