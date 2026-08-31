#!/usr/bin/env python3
"""Render a three-song old/current/pure-DSP waveform audit.

Inputs are read-only JSON snapshots produced by `overview_structure_audit.rs` and
`extract_dsp_waveform_features.py`. The script never imports application code and never writes a
production waveform cache.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Callable

import numpy as np
from PIL import Image, ImageDraw, ImageFont


FONT_PATH = "/System/Library/Fonts/STHeiti Medium.ttc"
INK = (27, 34, 44)
MUTED = (91, 103, 119)
PAPER = (244, 247, 250)
PANEL = (255, 255, 255)
BORDER = (217, 224, 232)
GRID = (234, 239, 244)
BASELINE = (197, 206, 217)


def font(size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(FONT_PATH, size=size)


def clamp(value: float, low: float, high: float) -> float:
    return min(high, max(low, value if math.isfinite(value) else low))


def moving_average(values: np.ndarray, span: int) -> np.ndarray:
    if span <= 1:
        return np.asarray(values, dtype=np.float64).copy()
    span = min(span, len(values))
    left = span // 2
    right = span - 1 - left
    padded = np.pad(np.asarray(values, dtype=np.float64), (left, right), mode="edge")
    cumulative = np.concatenate(([0.0], np.cumsum(padded, dtype=np.float64)))
    return (cumulative[span:] - cumulative[:-span]) / span


def format_time(seconds: float, decimals: int = 0) -> str:
    minutes = int(seconds // 60)
    remainder = seconds - minutes * 60
    if decimals:
        return f"{minutes}:{remainder:04.1f}"
    return f"{minutes}:{int(round(remainder)):02d}"


def count_label(count: int) -> str:
    return {1: "一", 2: "两", 3: "三", 4: "四", 5: "五"}.get(count, str(count))


def waveform_arrays(profile: dict) -> tuple[np.ndarray, np.ndarray]:
    wave = profile["waveform"]
    amplitude = np.asarray(wave["amp"], dtype=np.float64)
    rgb = np.column_stack((wave["r"], wave["g"], wave["b"])).astype(np.float64)
    return amplitude, rgb


def dsp_arrays(features: dict, key: str) -> tuple[np.ndarray, np.ndarray]:
    wave = features[key]
    amplitude = np.asarray(wave["amp"], dtype=np.float64)
    rgb = np.column_stack((wave["r"], wave["g"], wave["b"])).astype(np.float64)
    return amplitude, rgb


def balanced_frequency_rgb(rgb: np.ndarray, low_dominance: float = 0.96) -> np.ndarray:
    output = np.clip(np.asarray(rgb, dtype=np.float64), 0, 255).copy()
    strongest_secondary = max(output[1], output[2])
    if output[0] > strongest_secondary:
        output[0] = strongest_secondary + (output[0] - strongest_secondary) * low_dominance
    return output


def retained_saturation(rgb: np.ndarray, retention: float) -> np.ndarray:
    neutral = float(np.mean(rgb))
    return neutral + (rgb - neutral) * retention


def current_overview_palette(rgb: np.ndarray, _amplitude: float = 1.0) -> np.ndarray:
    output = balanced_frequency_rgb(rgb, 0.90)
    return np.rint(retained_saturation(output, 0.84)).clip(0, 255)


def candidate_overview_palette(rgb: np.ndarray, _amplitude: float = 1.0) -> np.ndarray:
    """Preserve analytical hue ratios; only cap display luminance/chroma."""
    output = retained_saturation(balanced_frequency_rgb(rgb, 0.97), 0.94)
    peak = float(np.max(output))
    if peak > 242:
        output *= 242 / peak
    return np.rint(output).clip(0, 255)


def detail_palette(rgb: np.ndarray, amplitude: float) -> np.ndarray:
    source = balanced_frequency_rgb(rgb, 0.95)
    peak = float(np.max(source))
    if peak <= 0:
        return np.zeros(3)
    floor = float(np.min(source))
    chroma = (peak - floor) / peak
    softened = retained_saturation(source, 0.82)
    softened_peak = float(np.max(softened))
    value = 184 + 53 * math.sqrt(chroma) + 5 * math.sqrt(clamp(amplitude, 0, 1))
    return np.rint(np.clip(softened * value / max(softened_peak, 1e-9), 0, 245))


def aggregate_columns(
    amplitude: np.ndarray,
    rgb: np.ndarray,
    width: int,
    *,
    statistic: str,
    palette: Callable[[np.ndarray, float], np.ndarray] | None,
) -> tuple[np.ndarray, np.ndarray]:
    output_amp = np.zeros(width, dtype=np.float64)
    output_rgb = np.zeros((width, 3), dtype=np.float64)
    count = len(amplitude)
    for x in range(width):
        first = math.floor(x * count / width)
        last = min(count, max(first + 1, math.ceil((x + 1) * count / width)))
        values = amplitude[first:last]
        if statistic == "max":
            value = float(np.max(values))
        elif statistic == "q72":
            value = float(np.quantile(values, 0.72))
        else:
            value = float(np.median(values))
        weights = values + 0.001
        colour = np.sum(rgb[first:last] * weights[:, None], axis=0) / np.sum(weights)
        output_amp[x] = value
        output_rgb[x] = palette(colour, value) if palette else colour
    return output_amp, np.rint(output_rgb).clip(0, 255).astype(np.uint8)


def make_grid(width: int, height: int, start: float, end: float, tick: float, label: float) -> np.ndarray:
    image = Image.new("RGB", (width, height), PANEL)
    draw = ImageDraw.Draw(image)
    first_tick = math.ceil(start / tick) * tick
    position = first_tick
    while position <= end + 1e-9:
        x = int(round((position - start) / max(end - start, 1e-9) * (width - 1)))
        draw.line((x, 0, x, height), fill=GRID, width=1)
        ratio = position / label
        if abs(ratio - round(ratio)) < 1e-7:
            draw.text(
                (x + 6, 5),
                format_time(position, decimals=1 if label < 1 else 0),
                font=font(18),
                fill=(142, 152, 165),
            )
        position += tick
    draw.line((0, height // 2, width, height // 2), fill=BASELINE, width=1)
    return np.asarray(image).copy()


def render_hard_columns(
    amplitude: np.ndarray,
    rgb: np.ndarray,
    height: int,
    *,
    start: float,
    end: float,
    tick: float,
    label: float,
) -> Image.Image:
    """Paint independent vertical columns; neighbouring heights are never connected."""
    width = len(amplitude)
    pixels = make_grid(width, height, start, end, tick, label)
    midpoint = height // 2
    available = max(1, midpoint - 2)
    for x in range(width):
        half = max(1, int(round(clamp(float(amplitude[x]), 0, 1) * available)))
        pixels[max(0, midpoint - half) : min(height, midpoint + half), x] = rgb[x]
    return Image.fromarray(pixels.astype(np.uint8), "RGB")


def render_signed_current(
    lower: np.ndarray,
    upper: np.ndarray,
    onset: np.ndarray,
    rgb: np.ndarray,
    height: int,
    *,
    start: float,
    end: float,
    tick: float,
    label: float,
) -> Image.Image:
    """Reproduce the current signed/interpolated contour for comparison."""
    width = len(lower)
    pixels = make_grid(width, height, start, end, tick, label)
    midpoint = height / 2
    available = max(1, midpoint - 2)
    for x in range(width):
        top = clamp(midpoint - max(0, upper[x]) * available, 0, height)
        bottom = clamp(midpoint + max(0, -lower[x]) * available, top, height)
        if bottom - top < 1:
            top, bottom = midpoint - 0.5, midpoint + 0.5
        first = max(0, min(height - 1, math.floor(top)))
        last = max(first, min(height - 1, math.ceil(bottom) - 1))
        fill = rgb[x].astype(np.float64)
        edge = np.clip(fill * (1 + 0.16 * clamp(onset[x], 0, 1)), 0, 255)
        if first == last:
            coverage = bottom - top
            pixels[first, x] = np.rint(pixels[first, x] * (1 - coverage) + edge * coverage)
            continue
        top_coverage = first + 1 - top
        pixels[first, x] = np.rint(pixels[first, x] * (1 - top_coverage) + edge * top_coverage)
        if last - first > 1:
            pixels[first + 1 : last, x] = fill
        bottom_coverage = bottom - last
        pixels[last, x] = np.rint(pixels[last, x] * (1 - bottom_coverage) + edge * bottom_coverage)
    return Image.fromarray(pixels.astype(np.uint8), "RGB")


def hard_interval_columns(
    amplitude: np.ndarray,
    rgb: np.ndarray,
    duration: float,
    start: float,
    end: float,
    width: int,
) -> tuple[np.ndarray, np.ndarray]:
    output_amp = np.zeros(width, dtype=np.float64)
    output_rgb = np.zeros((width, 3), dtype=np.float64)
    local_source_columns = len(amplitude) * (end - start) / max(duration, 1e-9)
    magnifying = width >= local_source_columns
    for x in range(width):
        t0 = start + x / width * (end - start)
        t1 = start + (x + 1) / width * (end - start)
        if magnifying:
            index = min(
                len(amplitude) - 1,
                max(0, math.floor((t0 + t1) / 2 / duration * len(amplitude))),
            )
            output_amp[x] = amplitude[index]
            output_rgb[x] = rgb[index]
            continue
        first = max(0, math.floor(t0 / duration * len(amplitude)))
        last = min(len(amplitude), max(first + 1, math.ceil(t1 / duration * len(amplitude))))
        values = amplitude[first:last]
        weights = values + 0.001
        output_amp[x] = float(np.max(values))
        output_rgb[x] = np.sum(rgb[first:last] * weights[:, None], axis=0) / np.sum(weights)
    display_rgb = np.vstack([detail_palette(colour, amp) for colour, amp in zip(output_rgb, output_amp)])
    return output_amp, np.rint(display_rgb).clip(0, 255).astype(np.uint8)


def srgb_to_linear(value: float) -> float:
    normalised = clamp(value / 255, 0, 1)
    return normalised / 12.92 if normalised <= 0.04045 else ((normalised + 0.055) / 1.055) ** 2.4


def linear_to_srgb(value: float) -> int:
    normalised = clamp(value, 0, 1)
    srgb = normalised * 12.92 if normalised <= 0.0031308 else 1.055 * normalised ** (1 / 2.4) - 0.055
    return round(srgb * 255)


def current_signed_columns(
    profile: dict, start: float, end: float, width: int
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    wave = profile["waveform"]
    amplitude, source_rgb = waveform_arrays(profile)
    minimum = np.asarray(wave["minimum"], dtype=np.float64)
    maximum = np.asarray(wave["maximum"], dtype=np.float64)
    transient = np.asarray(wave["transient"], dtype=np.float64) / 255
    duration = float(wave["duration"])
    lower = np.zeros(width, dtype=np.float64)
    upper = np.zeros(width, dtype=np.float64)
    onset = np.zeros(width, dtype=np.float64)
    display_rgb = np.zeros((width, 3), dtype=np.float64)
    for x in range(width):
        centre = start + (x + 0.5) / width * (end - start)
        position = clamp(centre / duration * (len(amplitude) - 1), 0, len(amplitude) - 1)
        left = math.floor(position)
        right = min(len(amplitude) - 1, left + 1)
        mix = position - left
        lower[x] = minimum[left] + (minimum[right] - minimum[left]) * mix
        upper[x] = maximum[left] + (maximum[right] - maximum[left]) * mix
        onset[x] = transient[left] + (transient[right] - transient[left]) * mix
        colour = np.empty(3)
        for channel in range(3):
            a = srgb_to_linear(source_rgb[left, channel])
            b = srgb_to_linear(source_rgb[right, channel])
            colour[channel] = linear_to_srgb(a + (b - a) * mix)
        display_rgb[x] = detail_palette(colour, max(0, upper[x], -lower[x]))
    return lower, upper, onset, np.rint(display_rgb).clip(0, 255).astype(np.uint8)


def candidate_detail_columns(
    features: dict, start: float, end: float, width: int
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    base, source_rgb = dsp_arrays(features, "detail")
    drum = np.asarray(features["detail"]["drum"], dtype=np.float64)
    duration = float(features["duration"])
    feature_hz = float(features["feature_hz"])
    # A loud, nearly flat remix intro otherwise occupies 80-95% of the display and leaves no
    # headroom for its real drums. Apply a higher amplitude exponent only where the local 180 ms
    # envelope proves that the signal is a sustained high-energy wall. This preserves ordinary
    # passages, lowers non-transient wall material, and lets independently detected onsets spend
    # the recovered headroom.
    slow_level = moving_average(base, max(3, round(feature_hz * 0.18)) | 1)
    wall_strength = np.clip((slow_level - 0.52) / 0.36, 0.0, 1.0)
    contrast_gamma = 1.0 + 1.8 * wall_strength
    contrast_base = np.power(np.clip(base, 0.0, 1.0), contrast_gamma)
    boosted = contrast_base + (1.0 - contrast_base) * 0.66 * np.power(drum, 0.86)
    amplitude, rgb = hard_interval_columns(boosted, source_rgb, duration, start, end, width)
    base_screen, _ = hard_interval_columns(contrast_base, source_rgb, duration, start, end, width)
    drum_screen, _ = hard_interval_columns(drum, source_rgb, duration, start, end, width)
    return amplitude, rgb, base_screen, drum_screen


def select_windows(features: dict) -> tuple[float, float, float, float]:
    duration = float(features["duration"])
    hz = float(features["feature_hz"])
    drum = np.asarray(features["detail"]["drum"], dtype=np.float64)
    amplitude = np.asarray(features["detail"]["amp"], dtype=np.float64)
    score = np.power(drum, 0.72) * (0.55 + 0.45 * amplitude)

    def best_window(values: np.ndarray, length: int, first: int, last: int) -> int:
        length = min(length, len(values))
        cumulative = np.concatenate(([0.0], np.cumsum(values, dtype=np.float64)))
        sums = cumulative[length:] - cumulative[:-length]
        allowed_first = max(0, min(len(sums) - 1, first))
        allowed_last = max(allowed_first + 1, min(len(sums), last))
        return allowed_first + int(np.argmax(sums[allowed_first:allowed_last]))

    context_length = max(1, round(30 * hz))
    margin = round(min(12.0, max(0.0, (duration - 30) / 3)) * hz)
    title = str(features.get("title", "")).casefold()
    intro_stress_test = "sh1ne core" in title or "shine core" in title
    if intro_stress_test:
        # The user selected this remix specifically because its noisy, high-energy intro hides
        # strong drums in the current waveform. Keep the context anchored there; only the 4 s
        # sub-window is selected by onset evidence.
        context_index = 0
    else:
        context_index = best_window(
            score,
            context_length,
            margin,
            len(score) - context_length - margin + 1,
        )
    context_start = context_index / hz
    context_end = min(duration, (context_index + context_length) / hz)
    zoom_length = max(1, round(4 * hz))
    local_end = min(len(score), context_index + context_length)
    zoom_index = best_window(
        score,
        zoom_length,
        context_index,
        local_end - zoom_length + 1,
    )
    zoom_start = zoom_index / hz
    zoom_end = min(duration, (zoom_index + zoom_length) / hz)
    return context_start, context_end, zoom_start, zoom_end


def overview_metrics(amplitude: np.ndarray, rgb: np.ndarray) -> dict[str, float]:
    ordered = np.sort(rgb.astype(np.float64), axis=1)
    peak = np.maximum(ordered[:, 2], 1)
    return {
        "height_span": float(np.quantile(amplitude, 0.90) - np.quantile(amplitude, 0.20)),
        "colour_separation": float(np.median((ordered[:, 2] - ordered[:, 1]) / peak)),
    }


def detail_metrics(
    amplitude: np.ndarray,
    base: np.ndarray,
    drum: np.ndarray,
    start: float,
    end: float,
) -> dict[str, float]:
    threshold = max(0.18, float(np.quantile(drum, 0.985)))
    candidates = np.flatnonzero(drum >= threshold)
    minimum_gap = max(1, round(0.035 / max(end - start, 1e-9) * len(amplitude)))
    selected: list[int] = []
    for index in sorted(candidates.tolist(), key=lambda value: drum[value], reverse=True):
        if all(abs(index - other) >= minimum_gap for other in selected):
            selected.append(index)
    events = np.asarray(sorted(selected), dtype=np.int64)
    event_peaks = amplitude[events] if events.size else np.asarray([], dtype=np.float64)
    base_peaks = base[events] if events.size else np.asarray([], dtype=np.float64)
    clearances: list[float] = []
    for left, right in zip(events, events[1:]):
        seconds = (right - left) / len(amplitude) * (end - start)
        if not 0.07 <= seconds <= 0.8 or right <= left + 4:
            continue
        peak_level = min(amplitude[left], amplitude[right])
        valley = float(np.min(amplitude[left + 2 : right - 1]))
        clearances.append(1 - valley / max(peak_level, 1e-9))
    lift = (
        float(np.median(event_peaks / np.maximum(base_peaks, 1e-9) - 1))
        if event_peaks.size
        else 0.0
    )
    return {
        "detected_events": int(events.size),
        "event_height": float(np.median(event_peaks)) if event_peaks.size else 0.0,
        "event_lift": lift,
        "valley_clarity": float(np.median(clearances)) if clearances else 0.0,
        "quiet_floor": float(np.quantile(amplitude, 0.10)),
    }


def panel(canvas: Image.Image, location: tuple[int, int], size: tuple[int, int]) -> None:
    draw = ImageDraw.Draw(canvas)
    x, y = location
    width, height = size
    draw.rounded_rectangle(
        (x - 2, y - 2, x + width + 1, y + height + 1),
        10,
        fill=PANEL,
        outline=BORDER,
        width=2,
    )


def paste_wave(canvas: Image.Image, wave: Image.Image, location: tuple[int, int]) -> None:
    panel(canvas, location, wave.size)
    canvas.paste(wave, location)


def build_overview_profiles(audit: dict, features: dict, width: int = 1600) -> dict:
    legacy_amp, legacy_rgb = waveform_arrays(audit["legacy"])
    current_amp, current_rgb = waveform_arrays(audit["current"])
    candidate_amp, candidate_rgb = dsp_arrays(features, "overview")
    return {
        "legacy": aggregate_columns(legacy_amp, legacy_rgb, width, statistic="max", palette=None),
        "current": aggregate_columns(
            current_amp,
            current_rgb,
            width,
            statistic="median",
            palette=current_overview_palette,
        ),
        "candidate": aggregate_columns(
            candidate_amp,
            candidate_rgb,
            width,
            statistic="median",
            palette=candidate_overview_palette,
        ),
    }


def render_overview_board(items: list[tuple[dict, dict]], output: Path) -> dict:
    image_height = 215 + len(items) * 755 + 90
    image = Image.new("RGB", (3600, image_height), PAPER)
    draw = ImageDraw.Draw(image)
    draw.text(
        (180, 54),
        f"{count_label(len(items))}首真实歌曲：整曲预览结构对照",
        font=font(58),
        fill=INK,
    )
    draw.text(
        (180, 130),
        "旧版 / 当前实现 / 纯 DSP 像素柱候选（全部同一 1600 CSS px 时间轴；候选未接入）",
        font=font(28),
        fill=MUTED,
    )
    report: dict[str, dict] = {}
    row_specs = [
        ("legacy", "旧版 v0.2.41", "峰值列 · γ6 结构色"),
        ("current", "当前实现", "中位高度 · γ2.4 柔化色"),
        ("candidate", "纯 DSP 候选", "4096 结构桶 · γ6 频带色 · 硬像素柱"),
    ]
    for song_index, (audit, features) in enumerate(items):
        block_top = 215 + song_index * 755
        duration = float(features["duration"])
        draw.text((180, block_top), f"{song_index + 1}. {features['title']}", font=font(36), fill=INK)
        draw.text((3160, block_top + 5), format_time(duration), font=font(25), fill=MUTED)
        profiles = build_overview_profiles(audit, features)
        song_metrics = {key: overview_metrics(*values) for key, values in profiles.items()}
        report[features["title"]] = song_metrics
        for row_index, (key, title, note) in enumerate(row_specs):
            y = block_top + 58 + row_index * 218
            metric = song_metrics[key]
            draw.text((180, y), title, font=font(27), fill=INK)
            draw.text((510, y + 2), note, font=font(22), fill=MUTED)
            draw.text(
                (2700, y + 2),
                f"高度差 {metric['height_span'] * 100:.0f}% · 色差 {metric['colour_separation'] * 100:.0f}%",
                font=font(22),
                fill=MUTED,
            )
            amplitude, rgb = profiles[key]
            backing_amp = np.repeat(amplitude, 2)
            backing_rgb = np.repeat(rgb, 2, axis=0)
            wave = render_hard_columns(
                backing_amp,
                backing_rgb,
                126,
                start=0,
                end=duration,
                tick=30,
                label=60,
            )
            paste_wave(image, wave, (180, y + 39))
            ribbon = Image.fromarray(np.repeat(rgb[None, :, :], 12, axis=0), "RGB")
            ribbon = ribbon.resize((3200, 12), Image.Resampling.NEAREST)
            image.paste(ribbon, (180, y + 168))
    draw.text(
        (180, image_height - 52),
        "颜色仍是信号本身：红 / 绿 / 蓝 = 相对更强的低 / 中 / 高频；候选没有人声或鼓 STEM。",
        font=font(22),
        fill=MUTED,
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    image.save(output, optimize=True)
    return report


def render_detail_board(items: list[tuple[dict, dict]], output: Path) -> tuple[dict, dict]:
    image_height = 205 + len(items) * 1270 + 35
    image = Image.new("RGB", (3600, image_height), PAPER)
    draw = ImageDraw.Draw(image)
    draw.text(
        (180, 52),
        f"{count_label(len(items))}首真实歌曲：30 秒节奏上下文 + 4 秒鼓点放大",
        font=font(58),
        fill=INK,
    )
    draw.text(
        (180, 130),
        "候选用 400 列/秒独立像素桶；鼓特征只抬对应瞬态，不连接相邻高度（未接入）",
        font=font(28),
        fill=MUTED,
    )
    metrics_report: dict[str, dict] = {}
    windows_report: dict[str, dict] = {}
    width = 3200

    for song_index, (audit, features) in enumerate(items):
        block_top = 205 + song_index * 1270
        context_start, context_end, zoom_start, zoom_end = select_windows(features)
        title = features["title"]
        windows_report[title] = {
            "context": [context_start, context_end],
            "zoom": [zoom_start, zoom_end],
        }
        draw.text((180, block_top), f"{song_index + 1}. {title}", font=font(36), fill=INK)
        context_amp, context_rgb, _context_base, _context_drum = candidate_detail_columns(
            features, context_start, context_end, width
        )
        draw.text(
            (180, block_top + 52),
            f"候选 · 30 秒上下文 {format_time(context_start, 1)}–{format_time(context_end, 1)}",
            font=font(25),
            fill=INK,
        )
        draw.text((2070, block_top + 54), "屏幕像素内取峰；不做横向插值", font=font(21), fill=MUTED)
        context_wave = render_hard_columns(
            context_amp,
            context_rgb,
            172,
            start=context_start,
            end=context_end,
            tick=2,
            label=5,
        )
        paste_wave(image, context_wave, (180, block_top + 88))
        draw.text(
            (180, block_top + 286),
            f"同一局部放大 4 秒 · {format_time(zoom_start, 1)}–{format_time(zoom_end, 1)}",
            font=font(26),
            fill=INK,
        )

        legacy_amp_source, legacy_rgb_source = waveform_arrays(audit["legacy_detail"])
        legacy_duration = float(audit["legacy_detail"]["waveform"]["duration"])
        legacy_hz = len(legacy_amp_source) / legacy_duration
        current_hz = len(audit["current_detail"]["waveform"]["amp"]) / float(
            audit["current_detail"]["waveform"]["duration"]
        )
        legacy_amp, legacy_rgb = hard_interval_columns(
            legacy_amp_source,
            legacy_rgb_source,
            legacy_duration,
            zoom_start,
            zoom_end,
            width,
        )
        current_lower, current_upper, current_onset, current_rgb = current_signed_columns(
            audit["current_detail"], zoom_start, zoom_end, width
        )
        current_amp = np.maximum(current_upper, -current_lower)
        candidate_amp, candidate_rgb, candidate_base, candidate_drum = candidate_detail_columns(
            features, zoom_start, zoom_end, width
        )
        legacy_metrics = detail_metrics(
            legacy_amp, legacy_amp, candidate_drum, zoom_start, zoom_end
        )
        current_metrics = detail_metrics(
            current_amp, current_amp, candidate_drum, zoom_start, zoom_end
        )
        candidate_metrics = detail_metrics(
            candidate_amp, candidate_base, candidate_drum, zoom_start, zoom_end
        )
        metrics_report[title] = {
            "legacy": legacy_metrics,
            "current": current_metrics,
            "candidate": candidate_metrics,
            "legacy_source_columns_per_second": legacy_hz,
            "current_source_columns_per_second": current_hz,
            "candidate_source_columns_per_second": float(features["feature_hz"]),
        }
        row_data = [
            (
                "旧版细节",
                f"约 {legacy_hz:.0f} 列/秒硬桶；鼓点清楚但放大后每桶约 {400 / legacy_hz:.1f} CSS px",
                render_hard_columns(
                    legacy_amp,
                    legacy_rgb,
                    210,
                    start=zoom_start,
                    end=zoom_end,
                    tick=0.5,
                    label=1,
                ),
            ),
            (
                "当前细节",
                f"约 {current_hz:.0f} 列/秒 signed contour；横向插值把相邻桶连成圆包/三角坡",
                render_signed_current(
                    current_lower,
                    current_upper,
                    current_onset,
                    current_rgb,
                    210,
                    start=zoom_start,
                    end=zoom_end,
                    tick=0.5,
                    label=1,
                ),
            ),
            (
                "纯 DSP 候选",
                f"400 列/秒硬桶；检测 {candidate_metrics['detected_events']} 个局部鼓瞬态 · 中位抬峰 {candidate_metrics['event_lift'] * 100:.0f}%",
                render_hard_columns(
                    candidate_amp,
                    candidate_rgb,
                    210,
                    start=zoom_start,
                    end=zoom_end,
                    tick=0.5,
                    label=1,
                ),
            ),
        ]
        for row_index, (row_title, note, wave) in enumerate(row_data):
            y = block_top + 330 + row_index * 286
            draw.text((180, y), row_title, font=font(25), fill=INK)
            draw.text((540, y + 2), note, font=font(21), fill=MUTED)
            paste_wave(image, wave, (180, y + 38))

    draw.text(
        (180, image_height - 50),
        "“波”在这里仍是 PCM 包络；但 4 秒映射到 1600 CSS px 时，正确载体是逐时间桶峰值列，不是穿过稀疏点的曲线。",
        font=font(22),
        fill=MUTED,
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    image.save(output, optimize=True)
    return metrics_report, windows_report


def render_zoom_board(items: list[tuple[dict, dict]], output: Path) -> None:
    """A less vertically compressed board dedicated to the requested four-second comparison."""
    image_height = 195 + len(items) * 845 + 90
    image = Image.new("RGB", (3600, image_height), PAPER)
    draw = ImageDraw.Draw(image)
    draw.text(
        (180, 52),
        f"{count_label(len(items))}首真实歌曲：4 秒细节波形大图",
        font=font(58),
        fill=INK,
    )
    draw.text(
        (180, 130),
        "每首均为同一时间窗：旧版 / 当前 / 纯 DSP 400 列每秒候选（候选未接入）",
        font=font(28),
        fill=MUTED,
    )
    width = 3200
    for song_index, (audit, features) in enumerate(items):
        block_top = 195 + song_index * 845
        _context_start, _context_end, zoom_start, zoom_end = select_windows(features)
        draw.text(
            (180, block_top),
            f"{song_index + 1}. {features['title']}  ·  {format_time(zoom_start, 1)}–{format_time(zoom_end, 1)}",
            font=font(34),
            fill=INK,
        )
        legacy_amp_source, legacy_rgb_source = waveform_arrays(audit["legacy_detail"])
        legacy_duration = float(audit["legacy_detail"]["waveform"]["duration"])
        legacy_hz = len(legacy_amp_source) / legacy_duration
        legacy_amp, legacy_rgb = hard_interval_columns(
            legacy_amp_source,
            legacy_rgb_source,
            legacy_duration,
            zoom_start,
            zoom_end,
            width,
        )
        current_lower, current_upper, current_onset, current_rgb = current_signed_columns(
            audit["current_detail"], zoom_start, zoom_end, width
        )
        current_hz = len(audit["current_detail"]["waveform"]["amp"]) / float(
            audit["current_detail"]["waveform"]["duration"]
        )
        candidate_amp, candidate_rgb, candidate_base, candidate_drum = candidate_detail_columns(
            features, zoom_start, zoom_end, width
        )
        metric = detail_metrics(candidate_amp, candidate_base, candidate_drum, zoom_start, zoom_end)
        rows = [
            (
                "旧版",
                f"{legacy_hz:.0f} 列/秒硬桶 · 每桶约 {400 / legacy_hz:.1f} CSS px",
                render_hard_columns(
                    legacy_amp,
                    legacy_rgb,
                    210,
                    start=zoom_start,
                    end=zoom_end,
                    tick=0.5,
                    label=1,
                ),
            ),
            (
                "当前",
                f"{current_hz:.0f} 列/秒 signed contour · 横向插值",
                render_signed_current(
                    current_lower,
                    current_upper,
                    current_onset,
                    current_rgb,
                    210,
                    start=zoom_start,
                    end=zoom_end,
                    tick=0.5,
                    label=1,
                ),
            ),
            (
                "候选",
                f"400 列/秒硬桶 · {metric['detected_events']} 个鼓瞬态 · 中位抬峰 {metric['event_lift'] * 100:.0f}%",
                render_hard_columns(
                    candidate_amp,
                    candidate_rgb,
                    210,
                    start=zoom_start,
                    end=zoom_end,
                    tick=0.5,
                    label=1,
                ),
            ),
        ]
        for row_index, (title, note, wave) in enumerate(rows):
            y = block_top + 48 + row_index * 260
            draw.text((180, y), title, font=font(25), fill=INK)
            draw.text((410, y + 2), note, font=font(21), fill=MUTED)
            paste_wave(image, wave, (180, y + 36))
    draw.text(
        (180, image_height - 52),
        "候选的 10 ms 重叠分析窗抑制载波毛刺；400 Hz 时间栅格和逐列峰值仍原样保留。",
        font=font(22),
        fill=MUTED,
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    image.save(output, optimize=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("output_dir", type=Path)
    parser.add_argument(
        "--pair",
        action="append",
        nargs=2,
        metavar=("AUDIT_JSON", "DSP_JSON"),
        required=True,
    )
    args = parser.parse_args()
    items: list[tuple[dict, dict]] = []
    for audit_path, dsp_path in args.pair:
        audit = json.loads(Path(audit_path).read_text())
        features = json.loads(Path(dsp_path).read_text())
        if Path(audit["source_path"]).resolve() != Path(features["source_path"]).resolve():
            raise ValueError(f"审计数据与 DSP 特征不是同一首歌：{audit_path} / {dsp_path}")
        items.append((audit, features))
    if not items:
        raise ValueError("至少需要一首歌")

    args.output_dir.mkdir(parents=True, exist_ok=True)
    overview_path = args.output_dir / f"overview-{len(items)}songs-old-current-dsp-candidate.png"
    detail_path = args.output_dir / f"detail-{len(items)}songs-context-and-zoom-dsp-candidate.png"
    zoom_path = args.output_dir / f"detail-4s-{len(items)}songs-old-current-dsp-candidate.png"
    overview_report = render_overview_board(items, overview_path)
    detail_report, windows = render_detail_board(items, detail_path)
    render_zoom_board(items, zoom_path)
    report = {
        "schema": "kdj-waveform-visual-audit-pure-dsp-v4",
        "production_modified": False,
        "source_count": len(items),
        "sources": [features["source_path"] for _audit, features in items],
        "method": items[0][1]["method"],
        "windows": windows,
        "overview": overview_report,
        "detail": detail_report,
        "artifacts": {
            "overview": str(overview_path),
            "detail": str(detail_path),
            "detail_zoom": str(zoom_path),
        },
    }
    metrics_path = args.output_dir / "metrics-pure-dsp-v4.json"
    metrics_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
