#!/usr/bin/env python3
"""Render a retina-faithful A/B sheet from waveform_compare's JSON payload.

Pillow is used only as an offline comparison renderer. The candidate analysis itself is Rust and
remains outside the KDJ runtime until the user approves integration.
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont


BACKGROUND = np.array([7, 10, 17], dtype=np.uint8)
RAIL = np.array([10, 15, 25], dtype=np.uint8)
CARD = (15, 21, 34)
GRID = (36, 46, 65)
TEXT = (235, 240, 250)
MUTED = (139, 153, 177)
ACCENT = (92, 226, 204)
DPR = 2


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    candidates = [
        "/System/Library/Fonts/STHeiti Medium.ttc" if bold else "/System/Library/Fonts/STHeiti Light.ttc",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    ]
    for candidate in candidates:
        try:
            return ImageFont.truetype(candidate, size=size)
        except OSError:
            pass
    return ImageFont.load_default()


def srgb_to_linear(value: np.ndarray) -> np.ndarray:
    value = np.clip(value, 0.0, 1.0)
    return np.where(value <= 0.04045, value / 12.92, ((value + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(value: np.ndarray) -> np.ndarray:
    value = np.clip(value, 0.0, 1.0)
    return np.where(value <= 0.0031308, value * 12.92, 1.055 * value ** (1 / 2.4) - 0.055)


def release_palette(rgb: np.ndarray) -> np.ndarray:
    source = rgb.astype(np.float64)
    secondary = np.maximum(source[:, 1], source[:, 2])
    source[:, 0] = np.where(
        source[:, 0] > secondary,
        secondary + (source[:, 0] - secondary) * 0.9,
        source[:, 0],
    )
    neutral = source.mean(axis=1, keepdims=True)
    softened = neutral + (source - neutral) * 0.84
    return np.clip(np.rint(softened), 0, 255).astype(np.uint8)


def detail_palette(rgb: np.ndarray, amp: np.ndarray) -> np.ndarray:
    source = rgb.astype(np.float64)
    secondary = np.maximum(source[:, 1], source[:, 2])
    source[:, 0] = np.where(
        source[:, 0] > secondary,
        secondary + (source[:, 0] - secondary) * 0.9,
        source[:, 0],
    )
    peak = source.max(axis=1)
    floor = source.min(axis=1)
    chroma = np.divide(peak - floor, peak, out=np.zeros_like(peak), where=peak > 0)
    neutral = source.mean(axis=1, keepdims=True)
    softened = neutral + (source - neutral) * 0.70
    softened_peak = softened.max(axis=1)
    target = 178 + 50 * np.sqrt(chroma) + 6 * np.sqrt(np.clip(amp, 0, 1))
    scale = np.divide(target, softened_peak, out=np.zeros_like(target), where=softened_peak > 0)
    return np.clip(np.rint(softened * scale[:, None]), 0, 255).astype(np.uint8)


def current_overview_columns(wave: dict, width: int) -> tuple[np.ndarray, np.ndarray]:
    amp = np.asarray(wave["amp"], dtype=np.float64)
    source_rgb = np.column_stack([wave["r"], wave["g"], wave["b"]]).astype(np.float64)
    logical_width = max(1, width // DPR)
    logical_amp = np.zeros(logical_width, dtype=np.float64)
    logical_rgb = np.zeros((logical_width, 3), dtype=np.float64)
    for x in range(logical_width):
        first = math.floor(x * len(amp) / logical_width)
        last = min(len(amp), max(first + 1, math.floor((x + 1) * len(amp) / logical_width)))
        values = amp[first:last]
        logical_amp[x] = float(np.median(values)) if len(values) else 0.0
        weight = values + 0.001
        logical_rgb[x] = np.average(source_rgb[first:last], axis=0, weights=weight)
    physical_amp = np.repeat(logical_amp, DPR)[:width]
    physical_rgb = np.repeat(logical_rgb, DPR, axis=0)[:width]
    if len(physical_amp) < width:
        pad = width - len(physical_amp)
        physical_amp = np.pad(physical_amp, (0, pad), mode="edge")
        physical_rgb = np.pad(physical_rgb, ((0, pad), (0, 0)), mode="edge")
    return physical_amp, release_palette(physical_rgb)


def current_detail_columns(
    wave: dict, width: int, start_seconds: float, end_seconds: float
) -> tuple[np.ndarray, np.ndarray]:
    amp = np.asarray(wave["amp"], dtype=np.float64)
    source_rgb = np.column_stack([wave["r"], wave["g"], wave["b"]]).astype(np.float64)
    duration = max(float(wave["duration"]), 1e-9)
    column_amp = np.zeros(width, dtype=np.float64)
    column_rgb = np.zeros((width, 3), dtype=np.float64)
    for x in range(width):
        t0 = start_seconds + x / width * (end_seconds - start_seconds)
        t1 = start_seconds + (x + 1) / width * (end_seconds - start_seconds)
        first = max(0, math.floor(t0 / duration * len(amp)))
        last = min(len(amp), max(first + 1, math.ceil(t1 / duration * len(amp))))
        values = amp[first:last]
        if not len(values):
            continue
        column_amp[x] = float(values.max())
        weights = values + 0.001
        column_rgb[x] = np.average(source_rgb[first:last], axis=0, weights=weights)

    # Match WaveformCanvas.ts: one physical-pixel triangular colour footprint, peak-preserving.
    smooth_rgb = np.zeros_like(column_rgb)
    smooth_amp = column_amp.copy()
    for x in range(width):
        total = 0.0
        for offset, kernel in ((-1, 0.25), (0, 0.5), (1, 0.25)):
            index = x + offset
            if index < 0 or index >= width:
                continue
            weight = kernel * (0.2 + column_amp[index])
            smooth_rgb[x] += column_rgb[index] * weight
            smooth_amp[x] = max(smooth_amp[x], column_amp[index])
            total += weight
        if total > 0:
            smooth_rgb[x] /= total
    return smooth_amp, detail_palette(smooth_rgb, smooth_amp)


def render_rectangles(amp: np.ndarray, rgb: np.ndarray, width: int, height: int) -> Image.Image:
    pixels = np.broadcast_to(RAIL, (height, width, 3)).copy()
    mid = height / 2
    usable = max(1.0, mid - DPR)
    for x in range(width):
        half = max(DPR / 2, float(amp[x]) * usable)
        top = max(0, int(math.floor(mid - half)))
        bottom = min(height, int(math.ceil(mid + half)))
        pixels[top:bottom, x] = rgb[x]
    return Image.fromarray(pixels, mode="RGB")


def candidate_columns(
    wave: dict,
    width: int,
    start_seconds: float,
    end_seconds: float,
    supersample: int,
    profile: str,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    source_min = np.asarray(wave["minimum"], dtype=np.float64)
    source_max = np.asarray(wave["maximum"], dtype=np.float64)
    source_transient = np.asarray(wave["transient"], dtype=np.float64) / 255.0
    duration = max(float(wave["duration"]), 1e-9)
    source_x = np.linspace(0.0, duration, len(source_min), endpoint=False)
    target_x = np.linspace(start_seconds, end_seconds, width * supersample, endpoint=False)
    minimum = np.interp(target_x, source_x, source_min, left=0.0, right=0.0)
    maximum = np.interp(target_x, source_x, source_max, left=0.0, right=0.0)
    transient = np.interp(target_x, source_x, source_transient, left=0.0, right=0.0)
    if profile == "overview":
        _, display_rgb = current_overview_columns(wave, width)
    else:
        _, display_rgb = current_detail_columns(wave, width, start_seconds, end_seconds)
    display_x = np.linspace(start_seconds, end_seconds, width, endpoint=False)
    linear = srgb_to_linear(display_rgb.astype(np.float64) / 255.0)
    target_linear = np.column_stack(
        [np.interp(target_x, display_x, linear[:, channel]) for channel in range(3)]
    )
    rgb = np.clip(np.rint(linear_to_srgb(target_linear) * 255), 0, 255).astype(np.uint8)
    return minimum, maximum, rgb, transient


def render_contour(
    wave: dict,
    width: int,
    height: int,
    start_seconds: float,
    end_seconds: float,
    profile: str,
) -> Image.Image:
    supersample = 3
    minimum, maximum, rgb, transient = candidate_columns(
        wave, width, start_seconds, end_seconds, supersample, profile
    )
    high_width = width * supersample
    high_height = height * supersample
    pixels = np.broadcast_to(RAIL, (high_height, high_width, 3)).copy()
    mid = high_height / 2
    usable = max(1.0, mid - DPR * supersample)
    for x in range(high_width):
        top = max(0, int(math.floor(mid - max(0.0, maximum[x]) * usable)))
        bottom = min(high_height, int(math.ceil(mid + max(0.0, -minimum[x]) * usable)))
        if bottom <= top:
            center = int(mid)
            top, bottom = center, min(high_height, center + supersample)
        pixels[top:bottom, x] = rgb[x]
        if transient[x] > 0 and bottom > top:
            lift = 1.0 + 0.16 * transient[x]
            edge = max(1, supersample)
            pixels[top : min(bottom, top + edge), x] = np.clip(
                pixels[top : min(bottom, top + edge), x].astype(np.float64) * lift, 0, 255
            ).astype(np.uint8)
            pixels[max(top, bottom - edge) : bottom, x] = np.clip(
                pixels[max(top, bottom - edge) : bottom, x].astype(np.float64) * lift, 0, 255
            ).astype(np.uint8)
    high = Image.fromarray(pixels, mode="RGB")
    return high.resize((width, height), Image.Resampling.LANCZOS)


def add_grid(image: Image.Image, divisions: int = 12) -> Image.Image:
    draw = ImageDraw.Draw(image)
    width, height = image.size
    for division in range(1, divisions):
        x = round(division * width / divisions)
        draw.line((x, 0, x, height), fill=GRID, width=1)
    draw.line((0, height // 2, width, height // 2), fill=(48, 59, 79), width=1)
    return image


def panel(draw: ImageDraw.ImageDraw, box: tuple[int, int, int, int], title: str) -> tuple[int, int, int, int]:
    x0, y0, x1, y1 = box
    draw.rounded_rectangle(box, radius=16, fill=CARD, outline=(27, 36, 53), width=2)
    draw.text((x0 + 18, y0 + 12), title, fill=MUTED, font=font(20, bold=True))
    return (x0 + 18, y0 + 46, x1 - 18, y1 - 16)


def format_seconds(value: float) -> str:
    minutes = int(value // 60)
    seconds = value - minutes * 60
    return f"{minutes}:{seconds:05.2f}"


def truncate(text: str, limit: int = 70) -> str:
    return text if len(text) <= limit else text[: limit - 1] + "…"


def render_track(track: dict, width: int = 2320) -> Image.Image:
    margin = 36
    gap = 28
    column_width = (width - margin * 2 - gap) // 2
    height = 590
    image = Image.new("RGB", (width, height), tuple(BACKGROUND.tolist()))
    draw = ImageDraw.Draw(image)
    draw.text((margin, 24), f"{track['index']:02d}  {truncate(track['display_name'])}", fill=TEXT, font=font(32, bold=True))
    detail = track["detail_window"]
    meta = (
        f"{format_seconds(track['duration'])}  ·  {track['sample_rate']} Hz  ·  "
        f"detail {detail['start_seconds']:.2f}–{detail['end_seconds']:.2f}s  ·  50 CSS px / 2× DPR"
    )
    draw.text((margin, 68), meta, fill=MUTED, font=font(20))

    left = margin
    right = margin + column_width + gap
    current_title = "CURRENT · amp-only RGB rectangles"
    candidate_title = "CANDIDATE v6 · detail/overview γ2.4 + contour"
    overview_y = 108
    overview_h = 174
    detail_y = 302
    detail_h = 210

    current_overview_box = panel(draw, (left, overview_y, left + column_width, overview_y + overview_h), current_title + " · overview")
    candidate_overview_box = panel(draw, (right, overview_y, right + column_width, overview_y + overview_h), candidate_title + " · overview")
    current_detail_box = panel(draw, (left, detail_y, left + column_width, detail_y + detail_h), current_title + " · detail")
    candidate_detail_box = panel(draw, (right, detail_y, right + column_width, detail_y + detail_h), candidate_title + " · detail")

    def paste_wave(box: tuple[int, int, int, int], wave_image: Image.Image) -> None:
        x0, y0, x1, y1 = box
        rail_y = y0 + max(0, (y1 - y0 - wave_image.height) // 2)
        image.paste(add_grid(wave_image), (x0, rail_y))

    overview_width = current_overview_box[2] - current_overview_box[0]
    overview_height = 100  # 50 CSS px at 2× DPR.
    current_amp, current_rgb = current_overview_columns(
        track["current"]["release_overview"], overview_width
    )
    paste_wave(
        current_overview_box,
        render_rectangles(current_amp, current_rgb, overview_width, overview_height),
    )
    paste_wave(
        candidate_overview_box,
        render_contour(
            track["candidate"]["release_overview"],
            overview_width,
            overview_height,
            0.0,
            track["duration"],
            "overview",
        ),
    )

    detail_width = current_detail_box[2] - current_detail_box[0]
    detail_height = 100
    start = detail["start_seconds"]
    end = detail["end_seconds"]
    current_amp, current_rgb = current_detail_columns(
        track["current"]["performance_detail"], detail_width, start, end
    )
    paste_wave(
        current_detail_box,
        render_rectangles(current_amp, current_rgb, detail_width, detail_height),
    )
    paste_wave(
        candidate_detail_box,
        render_contour(
            track["candidate"]["performance_detail"],
            detail_width,
            detail_height,
            start,
            end,
            "detail",
        ),
    )

    metrics = track["metrics"]
    footer = (
        f"source colour variation {metrics['current_detail_colour_variation']:.4f} → "
        f"{metrics['candidate_detail_colour_variation']:.4f}   |   "
        f"candidate detail γ2.4 · overview γ6.0 → γ2.4 · same spectral bands and display palettes"
    )
    draw.text((margin, 544), footer, fill=MUTED, font=font(18))
    return image


def render_header(payload: dict, width: int = 2320) -> Image.Image:
    height = 210
    image = Image.new("RGB", (width, height), tuple(BACKGROUND.tolist()))
    draw = ImageDraw.Draw(image)
    draw.text((48, 32), "KDJ WAVEFORM REBUILD · REAL-TRACK A/B", fill=TEXT, font=font(42, bold=True))
    draw.text(
        (48, 90),
        f"seed {payload['random_seed']}  ·  current KDJ vs standalone unified-γ2.4 Contour v6  ·  NOT WIRED INTO APP",
        fill=MUTED,
        font=font(22),
    )
    draw.text((48, 138), "Both profiles γ2.4", fill=(235, 145, 179), font=font(20, bold=True))
    draw.text((286, 138), "Signed min/max contour", fill=(118, 199, 228), font=font(20, bold=True))
    draw.text((548, 138), "Transient edge", fill=(225, 230, 240), font=font(20, bold=True))
    draw.text(
        (790, 138),
        "Same two generation profiles · same songs · same detail window · no Gaussian blur",
        fill=ACCENT,
        font=font(20),
    )
    draw.line((48, 192, width - 48, 192), fill=(29, 39, 57), width=2)
    return image


def main() -> int:
    if len(sys.argv) not in (2, 3):
        print("usage: render_comparison.py ANALYSIS_JSON [OUTPUT_DIR]", file=sys.stderr)
        return 2
    analysis_path = Path(sys.argv[1]).resolve()
    output_dir = Path(sys.argv[2]).resolve() if len(sys.argv) == 3 else analysis_path.parent
    output_dir.mkdir(parents=True, exist_ok=True)
    payload = json.loads(analysis_path.read_text(encoding="utf-8"))
    tracks = payload.get("tracks", [])
    if len(tracks) < 2:
        raise SystemExit("analysis payload must contain at least two tracks")

    width = 2320
    rendered_tracks = []
    for track in tracks:
        image = render_track(track, width)
        rendered_tracks.append(image)
        image.save(output_dir / f"track-{track['index']:02d}-comparison.png", optimize=True)

    header = render_header(payload, width)
    gap = 22
    total_height = header.height + sum(image.height for image in rendered_tracks) + gap * len(rendered_tracks) + 34
    sheet = Image.new("RGB", (width, total_height), tuple(BACKGROUND.tolist()))
    sheet.paste(header, (0, 0))
    y = header.height
    for image in rendered_tracks:
        sheet.paste(image, (0, y))
        y += image.height + gap
    footer = ImageDraw.Draw(sheet)
    footer.text(
        (48, total_height - 34),
        "Offline experiment artifact. Existing KDJ runtime files and waveform cache remain untouched.",
        fill=MUTED,
        font=font(17),
    )
    output = output_dir / "waveform-comparison.png"
    sheet.save(output, optimize=True)
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
