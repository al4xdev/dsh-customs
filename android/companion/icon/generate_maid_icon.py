#!/usr/bin/env python3
"""Derive a product launcher asset offline; never modify the bundled loading frames."""
import argparse
import hashlib
import math
from pathlib import Path
import shutil
import struct
import subprocess

SOURCE_SHA256 = "c4132f28c128c06d86874f61e7ba7ae8b6d305708127879cbc36c6ed3e7e4319"
CANVAS = 432  # 108dp at four pixels per dp; adaptive viewport is the central72dp.
SAFE_RADIUS = 132  # Entire visible character inside the central66dp diameter.
# One pixel of reserve also protects the outside corners of pixels, not just their centers.
PIXEL_CENTER_RADIUS = SAFE_RADIUS - 1
ROOT = Path(__file__).resolve().parents[1]
MAIN = ROOT / "app/src/main"
SOURCE = MAIN / "assets/companion/maid/thinking/00.png"
OUTPUT = MAIN / "res/drawable-nodpi/ic_companion_maid_foreground_pixels.png"


def image(magick, arguments, data=None):
    return subprocess.run([magick, "-limit", "thread", "1", *arguments], input=data,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True).stdout


def png_dimensions(data):
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("Expected PNG")
    return struct.unpack(">II", data[16:24])


def rgba(magick, png):
    width, height = png_dimensions(png)
    pixels = image(magick, ["png:-", "-alpha", "on", "-depth", "8", "rgba:-"], png)
    if len(pixels) != width * height * 4:
        raise ValueError("Unexpected RGBA length")
    return width, height, pixels


def visible(pixels, width):
    return [(index // 4 % width, index // 4 // width, pixels[index:index + 4])
            for index in range(0, len(pixels), 4) if pixels[index + 3] > 0]


def loader_digest():
    """Sorted source paths and file bytes, solely for proving this recipe leaves them intact."""
    base = MAIN / "assets/companion/maid"
    digest = hashlib.sha256()
    files = sorted(path for path in base.rglob("*") if path.is_file())
    for path in files:
        digest.update(path.relative_to(base).as_posix().encode("utf-8") + b"\0")
        digest.update(hashlib.sha256(path.read_bytes()).digest())
    return len(files), digest.hexdigest()


def generate(magick):
    source = SOURCE.read_bytes()
    if hashlib.sha256(source).hexdigest() != SOURCE_SHA256:
        raise ValueError("Bundled source frame changed; do not substitute or repaint it")
    width, height, pixels = rgba(magick, source)
    if (width, height) != (301, 288):
        raise ValueError("Unexpected source dimensions")
    opaque = visible(pixels, width)
    left = min(x for x, _, _ in opaque)
    top = min(y for _, y, _ in opaque)
    right = max(x for x, _, _ in opaque) + 1
    bottom = max(y for _, y, _ in opaque) + 1
    crop_width, crop_height = right - left, bottom - top
    radius = max(math.hypot(x - left + .5 - crop_width / 2, y - top + .5 - crop_height / 2)
                 for x, y, _ in opaque)
    target_width = max(1, math.floor(crop_width * PIXEL_CENTER_RADIUS / radius))
    source_colors = {pixel for _, _, pixel in opaque}
    while target_width > 0:
        target_height = max(1, round(target_width * crop_height / crop_width))
        png = image(magick, [str(SOURCE), "-crop", f"{crop_width}x{crop_height}+{left}+{top}", "+repage",
                            "-filter", "point", "-resize", f"{target_width}x{target_height}!",
                            "-background", "none", "-gravity", "center", "-extent", f"{CANVAS}x{CANVAS}",
                            "-strip", "-define", "png:exclude-chunk=all", "-define", "png:compression-level=9", "PNG32:-"])
        out_width, out_height, out_pixels = rgba(magick, png)
        if (out_width, out_height) != (CANVAS, CANVAS):
            raise ValueError("Unexpected foreground canvas")
        art = visible(out_pixels, out_width)
        max_radius = max(math.hypot(x + .5 - CANVAS / 2, y + .5 - CANVAS / 2) for x, y, _ in art)
        if not all(pixel in source_colors for _, _, pixel in art):
            raise ValueError("Conversion introduced new colors or altered alpha; nearest-neighbor only")
        if max_radius <= PIXEL_CENTER_RADIUS:
            return png, (target_width, target_height), max_radius, len(art)
        target_width -= 1
    raise ValueError("Cannot fit source in safe circle")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Check reproducibility without overwriting resources")
    args = parser.parse_args()
    magick = shutil.which("magick")
    if magick is None:
        raise SystemExit("Use an already available ImageMagick; this recipe installs nothing")
    before = loader_digest()
    png, size, radius, count = generate(magick)
    if args.check:
        if not OUTPUT.is_file() or OUTPUT.read_bytes() != png:
            raise SystemExit("Product icon differs from the deterministic recipe")
    else:
        # Fixed product-resource destination, never a source path, private dump or external checkout.
        if OUTPUT.resolve().parent != (MAIN / "res/drawable-nodpi").resolve():
            raise ValueError("Unexpected resource destination")
        OUTPUT.parent.mkdir(parents=True, exist_ok=True)
        if not OUTPUT.exists() or OUTPUT.read_bytes() != png:
            OUTPUT.write_bytes(png)
    if loader_digest() != before or hashlib.sha256(SOURCE.read_bytes()).hexdigest() != SOURCE_SHA256:
        raise ValueError("Original loading pack changed during conversion")
    print(f"source_sha256={SOURCE_SHA256}")
    print(f"foreground_sha256={hashlib.sha256(png).hexdigest()}")
    print(f"canvas={CANVAS}x{CANVAS}; resized_alpha_crop={size[0]}x{size[1]}; visible_pixels={count}")
    print(f"max_opaque_pixel_center_radius={radius:.6f}; allowed={PIXEL_CENTER_RADIUS}; safe_circle_radius={SAFE_RADIUS}")
    print(f"unchanged_loading_files={before[0]}; loading_pack_sha256={before[1]}")


if __name__ == "__main__":
    main()
