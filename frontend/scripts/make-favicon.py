"""Render public/favicon.svg and public/favicon-32.png from one pixel grid.

The mark is the same amber infield diamond as the link-preview card: a 16x16
grid of 2 px cells on a 32 px canvas, bases picked out in white. Run from
anywhere: `python3 frontend/scripts/make-favicon.py`.
"""

from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "public"

BG = "#0a0e15"
AMBER = "#e6a817"
WHITE = "#f5f7fa"

N = 6  # half-diagonal of the diamond, in cells
CELL = 2
SIZE = 32


def px(dx, dy):
    """Top-left pixel of cell (dx, dy), symmetric about the 32 px canvas."""
    return 16 + dx * CELL - 1, 16 + dy * CELL - 1


def cells():
    """(dx, dy) for the outline, the bases, and home plate."""
    outline = {
        (dx, dy)
        for dy in range(-N, N + 1)
        for dx in range(-N, N + 1)
        if abs(dx) + abs(dy) == N
    }
    bases = {(0, -N), (N, 0), (-N, 0)}
    home = {(0, N)}
    return outline, bases, home


outline, bases, home = cells()

# --- SVG ------------------------------------------------------------------
parts = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" '
    'viewBox="0 0 32 32" shape-rendering="crispEdges">',
    f'  <rect width="32" height="32" fill="{BG}"/>',
]
for fill, group in ((AMBER, outline - bases - home), (WHITE, bases | home)):
    parts.append(f'  <g fill="{fill}">')
    for dx, dy in sorted(group, key=lambda cell: (cell[1], cell[0])):
        x, y = px(dx, dy)
        parts.append(f'    <rect x="{x}" y="{y}" width="{CELL}" height="{CELL}"/>')
    parts.append("  </g>")
parts.append("</svg>")

(OUT / "favicon.svg").write_text("\n".join(parts) + "\n", encoding="utf-8")

# --- 32 px PNG fallback for browsers that ignore SVG icons ---------------
img = Image.new("RGB", (SIZE, SIZE), BG)
d = ImageDraw.Draw(img)
for dx, dy in outline - bases - home:
    x, y = px(dx, dy)
    d.rectangle([x, y, x + CELL - 1, y + CELL - 1], fill=AMBER)
for dx, dy in bases | home:
    x, y = px(dx, dy)
    d.rectangle([x, y, x + CELL - 1, y + CELL - 1], fill=WHITE)
img.save(OUT / "favicon-32.png", optimize=True)

print(f"wrote {OUT / 'favicon.svg'} and {OUT / 'favicon-32.png'}")
