#!/usr/bin/env python3
"""
make-test-photos.py: draws the four test pictures used by real-claude-test.ts
and writes them, as base64 text, into scripts/test-photos.ts.

WHY THIS EXISTS
  The real-API test needs pictures of a matcha bowl at different stages. Nobody
  on the team had real photos from the glasses at hand, and a public test must
  not carry anyone's private photos. So the pictures are DRAWN by this program.
  They are drawings, not photos, and the test says so in its output.

  This file is kept so that anyone can see exactly where the pictures came
  from, and can change them and run it again.

WHAT IT DRAWS (each 640x480, JPEG quality 80, seen from above, the way the
person wearing the glasses looks down at the table)
  emptyBowl        a pale ceramic bowl on a wooden table, empty
  powderBowl       the same bowl with a mound of bright green powder in the middle
  powderBowlAgain  the same content again, with the bowl a little to the side
                   and different light. This is "the learner did it right".
  foamBowl         the bowl filled with green tea with a light foamy top and bubbles

HOW TO RUN IT (needs Python 3 and Pillow: pip install pillow)
  python3 scripts/make-test-photos.py
      writes scripts/test-photos.ts
  python3 scripts/make-test-photos.py --preview /tmp/tinker-test-photos
      also writes the four .jpg files into that folder, to look at them

  Then build the test again (see scripts/README.md), because the pictures are
  baked into the bundle.

The drawing uses fixed random seeds, so the same pictures come out every time.
"""

import argparse
import base64
import io
import math
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

WIDTH, HEIGHT = 640, 480
QUALITY = 80
# Everything is drawn at three times the size and then shrunk. That gives
# smooth edges, which a plain drawing at 640x480 would not have.
SCALE = 3


def mix(a, b, t):
    """The colour that lies the fraction t of the way from colour a to colour b."""
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def circle_box(cx, cy, r):
    return [cx - r, cy - r, cx + r, cy + r]


def blob(cx, cy, r, rng, wobble, rough=0.0, points=220):
    """
    The outline of a slightly irregular round shape (a pile of powder or a
    patch of foam is never a perfect circle). A few sine waves with random
    strength push the edge in and out. `rough` adds small quick ripples on
    top, for the crumbly edge of a pile of powder.
    """
    waves = [(rng.uniform(0, math.tau), rng.uniform(0.3, 1.0), k) for k in (2, 3, 5, 7)]
    ripples = [(rng.uniform(0, math.tau), rng.uniform(0.4, 1.0), k) for k in (11, 17, 23, 31)]
    outline = []
    for i in range(points):
        angle = math.tau * i / points
        push = sum(strength * math.sin(k * angle + phase) / k for phase, strength, k in waves)
        crumble = sum(strength * math.sin(k * angle + phase) for phase, strength, k in ripples) / 4
        radius = r * (1 + wobble * push + rough * crumble)
        outline.append((cx + radius * math.cos(angle), cy + radius * math.sin(angle)))
    return outline


def soft(img, colour, opacity, blur, draw_shape):
    """
    Lay a soft-edged patch of one colour over the picture. `draw_shape` draws
    the patch in white on a black sheet. The sheet is blurred and then used as
    the amount of colour to put on each pixel. Used for shadows and highlights.
    """
    sheet = Image.new("L", img.size, 0)
    draw_shape(ImageDraw.Draw(sheet))
    if blur > 0:
        sheet = sheet.filter(ImageFilter.GaussianBlur(blur))
    sheet = sheet.point(lambda v: round(v * opacity))
    img.paste(Image.new("RGB", img.size, colour), (0, 0), sheet)


def keep_inside(img, original, cx, cy, r):
    """Undo everything that was painted outside the circle, using a copy made before."""
    hole = Image.new("L", img.size, 255)
    ImageDraw.Draw(hole).ellipse(circle_box(cx, cy, r), fill=0)
    img.paste(original, (0, 0), hole)


def draw_table(rng, wood):
    """A wooden table top: planks running left to right, with grain lines."""
    w, h = WIDTH * SCALE, HEIGHT * SCALE
    img = Image.new("RGB", (w, h), wood)
    draw = ImageDraw.Draw(img, "RGBA")

    plank = 118 * SCALE
    y = -rng.randint(0, plank // 2)
    while y < h:
        # Each plank is a touch lighter or darker than the one before.
        shade = rng.uniform(-0.07, 0.07)
        tone = mix(wood, (255, 240, 210) if shade > 0 else (40, 22, 8), abs(shade))
        draw.rectangle([0, y, w, y + plank], fill=tone + (255,))

        # Grain: thin wavy lines along the plank.
        for _ in range(26):
            gy = y + rng.uniform(4, plank - 4)
            dark = rng.random() < 0.65
            ink = (58, 34, 14) if dark else (236, 204, 160)
            alpha = rng.randint(14, 42)
            sway = rng.uniform(1.0, 5.0) * SCALE
            length = rng.uniform(0.0015, 0.004) / SCALE
            phase = rng.uniform(0, math.tau)
            line = [(x, gy + sway * math.sin(x * length * math.tau + phase)) for x in range(0, w + 24, 24)]
            draw.line(line, fill=ink + (alpha,), width=rng.choice([1, 1, 2]) * SCALE // 2 + 1)

        # The dark gap between two planks.
        draw.line([(0, y + plank), (w, y + plank)], fill=(46, 27, 12, 150), width=SCALE + 1)
        y += plank

    return img.filter(ImageFilter.GaussianBlur(SCALE * 0.5))


def draw_bowl(img, cx, cy, r, light):
    """
    An empty pale ceramic bowl seen from straight above.
    `light` is the direction the light comes from, as (x, y) with length 1.
    Returns the radius of the inside of the bowl, for the things drawn into it.
    """
    lx, ly = light
    rim_outer = r
    rim_inner = r * 0.905  # where the inside wall starts
    floor = r * 0.40  # the flat bottom

    cream = (240, 234, 221)
    wall_top = (228, 221, 206)
    wall_low = (180, 170, 152)
    floor_colour = (196, 187, 170)

    # The bowl's shadow on the table, on the side away from the light.
    soft(
        img,
        (30, 17, 8),
        0.55,
        r * 0.07,
        lambda d: d.ellipse(circle_box(cx - lx * r * 0.13, cy - ly * r * 0.13, r * 1.02), fill=255),
    )

    draw = ImageDraw.Draw(img)
    # The outside edge, then the rim.
    draw.ellipse(circle_box(cx, cy, rim_outer), fill=(186, 177, 160))
    draw.ellipse(circle_box(cx, cy, rim_outer - r * 0.012), fill=cream)

    # The inside wall: rings that get darker towards the bottom. That is what
    # makes the flat drawing look like something with depth.
    steps = 70
    for i in range(steps):
        t = i / (steps - 1)
        radius = rim_inner + (floor - rim_inner) * t
        draw.ellipse(circle_box(cx, cy, radius), fill=mix(wall_top, wall_low, t**0.8))
    draw.ellipse(circle_box(cx, cy, floor), fill=floor_colour)

    # A real bowl curves into its bottom. Blur the inside so the bottom has no hard edge.
    before = img.copy()
    blurred = img.filter(ImageFilter.GaussianBlur(r * 0.045))
    img.paste(blurred)
    keep_inside(img, before, cx, cy, rim_inner * 0.985)

    before = img.copy()
    # The rim throws a shadow onto the inside wall nearest the light...
    soft(
        img,
        (74, 62, 46),
        0.62,
        r * 0.10,
        lambda d: (
            d.ellipse(circle_box(cx, cy, rim_inner), fill=255),
            d.ellipse(circle_box(cx - lx * r * 0.27, cy - ly * r * 0.27, rim_inner * 0.97), fill=0),
        ),
    )
    # ...and the wall on the far side catches the light.
    soft(
        img,
        (255, 252, 244),
        0.70,
        r * 0.08,
        lambda d: (
            d.ellipse(circle_box(cx, cy, rim_inner * 0.97), fill=255),
            d.ellipse(circle_box(cx + lx * r * 0.17, cy + ly * r * 0.17, rim_inner * 0.97), fill=0),
        ),
    )
    # Both were painted with soft edges that spill over the rim. Put the rim back.
    keep_inside(img, before, cx, cy, rim_inner)

    # A bright line on the rim where the light hits it.
    draw = ImageDraw.Draw(img)
    towards = math.degrees(math.atan2(ly, lx))
    draw.arc(
        circle_box(cx, cy, (rim_outer + rim_inner) / 2),
        towards - 55,
        towards + 55,
        fill=(252, 250, 244),
        width=max(2, round(r * 0.022)),
    )
    return rim_inner


def draw_powder(img, cx, cy, r, light, rng):
    """A mound of bright green matcha powder in the middle of the bowl."""
    lx, ly = light
    size = r * 0.37
    edge = (92, 146, 30)
    body = (126, 186, 38)
    top = (158, 208, 62)

    def dust(count, near, spread, biggest, alpha):
        """Loose grains of powder scattered around the heap, as after sifting."""
        pen = ImageDraw.Draw(img, "RGBA")
        for _ in range(count):
            angle = rng.uniform(0, math.tau)
            dist = size * (near + abs(rng.gauss(0, spread)))
            dot = rng.uniform(0.6, biggest) * SCALE
            px, py = cx + dist * math.cos(angle), cy + dist * math.sin(angle)
            pen.ellipse(circle_box(px, py, dot), fill=mix(edge, body, rng.random()) + (rng.randint(*alpha),))

    dust(520, 0.92, 0.36, 1.8, (110, 215))

    # The heap's shadow on the bottom of the bowl.
    shadow = blob(cx - lx * size * 0.13, cy - ly * size * 0.13, size * 1.04, random.Random(5), 0.10)
    soft(img, (66, 74, 36), 0.50, size * 0.08, lambda d: d.polygon(shadow, fill=255))

    # The heap itself: the same rough shape drawn smaller and lighter each
    # time, moving a little towards the light. That reads as a low pile with a
    # lit top. The crumbly outline is what makes it powder and not a ball.
    layers = 14
    shape_seed = rng.randint(0, 10**6)
    draw = ImageDraw.Draw(img)
    for i in range(layers):
        t = i / (layers - 1)
        colour = mix(edge, body, min(1, t * 2.6)) if t < 0.38 else mix(body, top, (t - 0.38) / 0.62)
        shift = size * 0.12 * t
        outline = blob(
            cx + lx * shift,
            cy + ly * shift,
            size * (1 - 0.74 * t),
            random.Random(shape_seed),
            0.13,
            rough=0.05 * (1 - t),
        )
        draw.polygon(outline, fill=colour)

    # Small clumps and grains right on the edge, so the outline is not a clean line.
    dust(700, 0.90, 0.07, 2.6, (170, 255))

    # Powder is grainy: speckle the heap with lighter and darker dots.
    draw = ImageDraw.Draw(img, "RGBA")
    for _ in range(1500):
        angle = rng.uniform(0, math.tau)
        dist = size * 0.95 * math.sqrt(rng.random())
        dot = rng.uniform(0.5, 1.7) * SCALE
        px, py = cx + dist * math.cos(angle), cy + dist * math.sin(angle)
        ink = (198, 232, 104) if rng.random() < 0.45 else (64, 112, 20)
        draw.ellipse(circle_box(px, py, dot), fill=ink + (rng.randint(45, 120),))


def draw_foam(img, cx, cy, r, light, rng):
    """Whisked matcha: green tea up to near the rim, with a lighter foamy top and small bubbles."""
    lx, ly = light
    level = r * 0.80  # how far out the tea reaches on the bowl's wall
    tea = (74, 124, 34)
    tea_edge = (56, 100, 26)
    foam = (158, 200, 98)
    foam_light = (206, 232, 156)

    draw = ImageDraw.Draw(img)
    # The tea: a little darker right at the edge, where it is thin against the wall.
    draw.ellipse(circle_box(cx, cy, level), fill=tea_edge)
    draw.ellipse(circle_box(cx, cy, level * 0.975), fill=tea)

    # The foam covers nearly all of the surface, with an uneven edge.
    seed = rng.randint(0, 10**6)
    draw.polygon(blob(cx, cy, level * 0.93, random.Random(seed), 0.035), fill=mix(tea, foam, 0.6))
    draw.polygon(blob(cx, cy, level * 0.89, random.Random(seed), 0.04), fill=foam)

    before = img.copy()
    # Lighter, thicker foam in patches, most of it towards the light.
    for _ in range(14):
        angle = rng.uniform(0, math.tau)
        dist = level * 0.62 * math.sqrt(rng.random())
        px = cx + dist * math.cos(angle) + lx * level * 0.10
        py = cy + dist * math.sin(angle) + ly * level * 0.10
        patch = blob(px, py, level * rng.uniform(0.13, 0.30), random.Random(rng.randint(0, 10**6)), 0.25)
        soft(img, foam_light, 0.62, level * 0.045, lambda d, patch=patch: d.polygon(patch, fill=255))
    # Marks left by the whisk: a few faint darker streaks, each bent a little.
    draw = ImageDraw.Draw(img, "RGBA")
    for _ in range(7):
        sx = cx + rng.uniform(-0.6, 0.6) * level
        sy = cy + rng.uniform(-0.6, 0.6) * level
        heading = rng.uniform(0, math.tau)
        streak = []
        for _ in range(26):
            streak.append((sx, sy))
            heading += rng.uniform(-0.16, 0.16)
            sx += math.cos(heading) * level * 0.022
            sy += math.sin(heading) * level * 0.022
        draw.line(streak, fill=(112, 160, 62, 60), width=2 * SCALE, joint="curve")
    keep_inside(img, before, cx, cy, level * 0.90)

    # Bubbles: many tiny ones everywhere, some bigger ones near the edge.
    # Each is a pale ring with a slightly darker middle and a white glint.
    draw = ImageDraw.Draw(img, "RGBA")
    bubbles = []
    for _ in range(900):
        angle = rng.uniform(0, math.tau)
        dist = level * 0.87 * math.sqrt(rng.random())
        bubbles.append((angle, dist, rng.uniform(1.0, 2.6) * SCALE))
    for _ in range(60):
        angle = rng.uniform(0, math.tau)
        dist = level * rng.uniform(0.45, 0.86)
        bubbles.append((angle, dist, rng.uniform(3.0, 5.6) * SCALE))
    for angle, dist, size in bubbles:
        px, py = cx + dist * math.cos(angle), cy + dist * math.sin(angle)
        draw.ellipse(circle_box(px, py, size), fill=(128, 172, 76, 150), outline=(226, 242, 184, 235), width=SCALE)
        draw.ellipse(circle_box(px + lx * size * 0.35, py + ly * size * 0.35, size * 0.24), fill=(255, 255, 250, 225))

    # A soft sheen on the side towards the light, so the surface looks wet.
    before = img.copy()
    soft(
        img,
        (240, 250, 215),
        0.22,
        level * 0.14,
        lambda d: d.ellipse(circle_box(cx + lx * level * 0.36, cy + ly * level * 0.36, level * 0.36), fill=255),
    )
    keep_inside(img, before, cx, cy, level * 0.90)


def make_picture(content, *, seed, centre, radius, light_angle, wood, brightness):
    """
    Draw one picture.
      content      "empty", "powder" or "foam"
      centre       where the middle of the bowl is, in pixels of the final picture
      light_angle  the direction the light comes from, in degrees (0 is right, 90 is down)
      wood         the colour of the table
      brightness   1.0 is normal. Above that is a brighter room.
    """
    rng = random.Random(seed)
    light = (math.cos(math.radians(light_angle)), math.sin(math.radians(light_angle)))
    cx, cy, r = centre[0] * SCALE, centre[1] * SCALE, radius * SCALE

    img = draw_table(rng, wood)
    draw_bowl(img, cx, cy, r, light)
    if content == "powder":
        draw_powder(img, cx, cy, r, light, rng)
    elif content == "foam":
        draw_foam(img, cx, cy, r, light, rng)

    # Darker corners, as a wide camera lens gives.
    w, h = img.size
    corners = Image.new("L", (w // 8, h // 8), 0)
    ImageDraw.Draw(corners).ellipse([-w // 40, -h // 40, w // 8 + w // 40, h // 8 + h // 40], fill=255)
    corners = corners.filter(ImageFilter.GaussianBlur(w // 50)).resize((w, h))
    img = Image.composite(img, Image.eval(img, lambda v: round(v * 0.62)), corners)

    if brightness != 1.0:
        img = Image.eval(img, lambda v: min(255, round(v * brightness)))
    return img.resize((WIDTH, HEIGHT), Image.LANCZOS)


# The four pictures. powderBowl and powderBowlAgain show the same thing: only
# the place of the bowl, the light, the table shade and the exact shape of the
# pile differ, the way two real attempts would differ.
PICTURES = {
    "emptyBowl": dict(
        content="empty", seed=11, centre=(320, 244), radius=178, light_angle=225, wood=(150, 104, 62), brightness=1.0
    ),
    "powderBowl": dict(
        content="powder", seed=11, centre=(320, 244), radius=178, light_angle=225, wood=(150, 104, 62), brightness=1.0
    ),
    "powderBowlAgain": dict(
        content="powder", seed=29, centre=(352, 226), radius=170, light_angle=300, wood=(134, 96, 62), brightness=1.07
    ),
    "foamBowl": dict(
        content="foam", seed=11, centre=(320, 244), radius=178, light_angle=225, wood=(150, 104, 62), brightness=1.0
    ),
}

WHAT_IT_SHOWS = {
    "emptyBowl": "A pale ceramic bowl on a wooden table, empty.",
    "powderBowl": "The same bowl with a mound of bright green matcha powder in the middle.",
    "powderBowlAgain": "The same content as powderBowl, bowl shifted, different light and table shade. The learner doing the step correctly.",
    "foamBowl": "The bowl filled with green tea with a lighter foamy top and small bubbles.",
}

HEADER = """/**
 * test-photos.ts: the four test pictures for real-claude-test.ts, as base64 text.
 *
 * GENERATED by scripts/make-test-photos.py. Do not edit by hand. To change a
 * picture, change that program and run it again.
 *
 * These are DRAWINGS made for the test, not real photos from the glasses.
 * Each is a 640x480 JPEG, quality 80, seen from above. There is no "data:"
 * prefix: the text is exactly what goes into the `data` field of an image
 * sent to Claude, with the media type "image/jpeg".
 */
"""


def main():
    parser = argparse.ArgumentParser(description="Draw the test pictures and write scripts/test-photos.ts.")
    parser.add_argument("--preview", metavar="FOLDER", help="also write the four .jpg files into this folder")
    args = parser.parse_args()

    out_file = Path(__file__).resolve().parent / "test-photos.ts"
    preview = Path(args.preview) if args.preview else None
    if preview:
        preview.mkdir(parents=True, exist_ok=True)

    parts = [HEADER]
    for name, settings in PICTURES.items():
        picture = make_picture(**settings)
        buffer = io.BytesIO()
        picture.save(buffer, format="JPEG", quality=QUALITY)
        jpeg = buffer.getvalue()
        if preview:
            (preview / f"{name}.jpg").write_bytes(jpeg)
        encoded = base64.b64encode(jpeg).decode("ascii")
        parts.append(f"\n/** {WHAT_IT_SHOWS[name]} {len(jpeg)} bytes. */\n")
        parts.append(f'export const {name} = "{encoded}"\n')
        print(f"{name}: {picture.size[0]}x{picture.size[1]}, {len(jpeg)} bytes as JPEG")

    out_file.write_text("".join(parts), encoding="ascii")
    print(f"wrote {out_file}")


if __name__ == "__main__":
    main()
