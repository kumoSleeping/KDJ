#!/usr/bin/env python3
"""Compare production waveform colour with a non-integrated intra-section texture candidate.

The candidate never changes waveform height, timing, or the production cache. It keeps the slow
production colour as the section identity and raises only measured short-time chromatic residuals
inside strongly single-band passages. Mixed passages receive very little extra gain.
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

from render_waveform_semantic_variants import VARIANTS, candidate_source_amplitude, semantic_rgb
from render_waveform_structure_audit import (
    INK,
    MUTED,
    PANEL,
    PAPER,
    clamp,
    font,
    format_time,
    moving_average,
    panel,
    render_hard_columns,
)


OVERVIEW_TEXTURE_BASE_GAIN = 0.08
OVERVIEW_TEXTURE_BLOCK_GAIN = 0.18
OVERVIEW_TEXTURE_SPAN_SECONDS = 1.05
OVERVIEW_CANDIDATE_SATURATION = 0.72

DETAIL_TEXTURE_BASE_GAIN = 0.10
DETAIL_TEXTURE_BLOCK_GAIN = 0.25
DETAIL_TEXTURE_SPAN_SECONDS = 0.42
DETAIL_CANDIDATE_SATURATION = 0.60


def channel_matrix(wave: dict) -> np.ndarray:
    return np.column_stack((wave["r"], wave["g"], wave["b"])).astype(np.float64)


def moving_matrix(values: np.ndarray, span: int) -> np.ndarray:
    return np.column_stack([moving_average(values[:, channel], span) for channel in range(3)])


def chromaticity(values: np.ndarray) -> np.ndarray:
    source = np.maximum(np.asarray(values, dtype=np.float64), 0.0)
    return source / np.maximum(np.sum(source, axis=1, keepdims=True), 1e-9)


def dominant_block_strength(proportions: np.ndarray) -> np.ndarray:
    ordered = np.sort(proportions, axis=1)
    dominance = ordered[:, -1] - ordered[:, -2]
    return np.clip((dominance - 0.10) / 0.42, 0.0, 1.0)


def robust_unit(values: np.ndarray, low_quantile: float, high_quantile: float) -> np.ndarray:
    low = float(np.quantile(values, low_quantile))
    high = float(np.quantile(values, high_quantile))
    return np.clip((values - low) / max(high - low, 1e-9), 0.0, 1.0)


def multiscale_colour(
    macro_rgb: np.ndarray,
    texture_rgb: np.ndarray,
    columns_per_second: float,
    *,
    span_seconds: float,
    base_gain: float,
    block_gain: float,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Retain the section hue while exposing real short-time spectral residuals.

    The residual is zero-mean around a local acoustic baseline, so this cannot invent a new section
    colour. Its gain rises only when one measured band already dominates the slow structure.
    """

    macro = chromaticity(macro_rgb)
    texture = chromaticity(texture_rgb)
    span = max(3, round(columns_per_second * span_seconds)) | 1
    residual = texture - moving_matrix(texture, span)
    block_strength = dominant_block_strength(macro)
    gain = base_gain + block_gain * block_strength
    candidate = np.maximum(macro + residual * gain[:, None], 0.025)
    candidate /= np.maximum(np.sum(candidate, axis=1, keepdims=True), 1e-9)

    novelty = robust_unit(np.linalg.norm(residual, axis=1), 0.45, 0.985)
    # Stable sections are slightly quieter in colour value; measured changes recover that value.
    value = 0.91 + 0.09 * np.sqrt(novelty)
    source_rgb = candidate / np.maximum(np.max(candidate, axis=1, keepdims=True), 1e-9)
    source_rgb *= 255 * value[:, None]
    return source_rgb, novelty, block_strength


def balanced_low(values: np.ndarray, retention: float) -> np.ndarray:
    output = np.clip(np.asarray(values, dtype=np.float64), 0.0, 255.0).copy()
    secondary = np.maximum(output[:, 1], output[:, 2])
    dominant = output[:, 0] > secondary
    output[dominant, 0] = secondary[dominant] + (
        output[dominant, 0] - secondary[dominant]
    ) * retention
    return output


def retain_saturation(values: np.ndarray, retention: float) -> np.ndarray:
    neutral = np.mean(values, axis=1, keepdims=True)
    return neutral + (values - neutral) * retention


def overview_palette(
    values: np.ndarray,
    *,
    saturation: float,
    low_dominance: float,
    cap: float,
) -> np.ndarray:
    output = retain_saturation(balanced_low(values, low_dominance), saturation)
    peak = np.max(output, axis=1)
    scale = np.minimum(1.0, cap / np.maximum(peak, 1e-9))
    return np.rint(output * scale[:, None]).clip(0, 255).astype(np.uint8)


def detail_palette(
    values: np.ndarray,
    amplitude: np.ndarray,
    *,
    candidate: bool,
    novelty: np.ndarray | None = None,
    transient: np.ndarray | None = None,
) -> np.ndarray:
    low_dominance = 0.93 if candidate else 0.95
    saturation = DETAIL_CANDIDATE_SATURATION if candidate else 0.76
    source = balanced_low(values, low_dominance)
    peak = np.max(source, axis=1)
    floor = np.min(source, axis=1)
    chroma = (peak - floor) / np.maximum(peak, 1e-9)
    softened = retain_saturation(source, saturation)
    if candidate:
        texture = np.zeros(len(source)) if novelty is None else np.asarray(novelty)
        drum = np.zeros(len(source)) if transient is None else np.asarray(transient)
        value = (
            174
            + 42 * np.sqrt(chroma)
            + 4 * np.sqrt(np.clip(amplitude, 0.0, 1.0))
            + 12 * np.sqrt(np.clip(texture, 0.0, 1.0))
            + 4 * np.power(np.clip(drum, 0.0, 1.0), 0.7)
        )
        cap = 238
    else:
        value = 184 + 53 * np.sqrt(chroma) + 5 * np.sqrt(np.clip(amplitude, 0.0, 1.0))
        cap = 245
    scale = value / np.maximum(np.max(softened, axis=1), 1e-9)
    return np.rint(np.clip(softened * scale[:, None], 0.0, cap)).astype(np.uint8)


def aggregate_to_count(
    amplitude: np.ndarray,
    rgb: np.ndarray,
    count: int,
) -> tuple[np.ndarray, np.ndarray]:
    output_amp = np.zeros(count, dtype=np.float64)
    output_rgb = np.zeros((count, 3), dtype=np.float64)
    for index in range(count):
        first = math.floor(index * len(amplitude) / count)
        last = min(
            len(amplitude),
            max(first + 1, math.ceil((index + 1) * len(amplitude) / count)),
        )
        values = amplitude[first:last]
        weights = values + 0.001
        output_amp[index] = float(np.median(values))
        output_rgb[index] = np.sum(rgb[first:last] * weights[:, None], axis=0) / np.sum(weights)
    return output_amp, output_rgb


def screen_columns(
    amplitude: np.ndarray,
    rgb: np.ndarray,
    duration: float,
    start: float,
    end: float,
    width: int,
    *extras: np.ndarray,
    amplitude_statistic: str = "max",
) -> tuple[np.ndarray, np.ndarray, list[np.ndarray]]:
    output_amp = np.zeros(width, dtype=np.float64)
    output_rgb = np.zeros((width, 3), dtype=np.float64)
    output_extras = [np.zeros(width, dtype=np.float64) for _ in extras]
    source_columns = len(amplitude) * (end - start) / max(duration, 1e-9)
    magnifying = width >= source_columns
    for x in range(width):
        t0 = start + x / width * (end - start)
        t1 = start + (x + 1) / width * (end - start)
        if magnifying:
            index = min(
                len(amplitude) - 1,
                max(0, math.floor((t0 + t1) * 0.5 / duration * len(amplitude))),
            )
            output_amp[x] = amplitude[index]
            output_rgb[x] = rgb[index]
            for output, source in zip(output_extras, extras):
                output[x] = source[index]
            continue
        first = max(0, math.floor(t0 / duration * len(amplitude)))
        last = min(
            len(amplitude),
            max(first + 1, math.ceil(t1 / duration * len(amplitude))),
        )
        values = amplitude[first:last]
        weights = values + 0.001
        output_amp[x] = (
            float(np.median(values))
            if amplitude_statistic == "median"
            else float(np.max(values))
        )
        output_rgb[x] = np.sum(rgb[first:last] * weights[:, None], axis=0) / np.sum(weights)
        for output, source in zip(output_extras, extras):
            output[x] = float(np.max(source[first:last]))
    return output_amp, output_rgb, output_extras


def select_dominant_window(
    rgb: np.ndarray,
    amplitude: np.ndarray,
    target: int,
    duration: float,
    seconds: float,
) -> tuple[float, float, tuple[int, int]]:
    proportions = chromaticity(rgb)
    other = np.max(np.delete(proportions, target, axis=1), axis=1)
    dominance = proportions[:, target] - other
    score = dominance * (0.35 + 0.65 * np.clip(amplitude, 0.0, 1.0))
    columns_per_second = len(score) / duration
    length = min(len(score), max(1, round(seconds * columns_per_second)))
    cumulative = np.concatenate(([0.0], np.cumsum(score, dtype=np.float64)))
    sums = cumulative[length:] - cumulative[:-length]
    labels = (np.argmax(proportions, axis=1) == target).astype(np.float64)
    label_cumulative = np.concatenate(([0.0], np.cumsum(labels, dtype=np.float64)))
    label_share = (label_cumulative[length:] - label_cumulative[:-length]) / length
    metric = sums / length + 0.16 * label_share
    start = int(np.argmax(metric))
    end = min(len(score), start + length)
    start_seconds = start / columns_per_second
    return start_seconds, min(duration, end / columns_per_second), (start, end)


def median_saturation(rgb: np.ndarray) -> float:
    peak = np.maximum(np.max(rgb.astype(np.float64), axis=1), 1.0)
    return float(np.median((peak - np.min(rgb, axis=1)) / peak))


def median_adjacent_delta(rgb: np.ndarray, first: int, last: int) -> float:
    local = rgb[first:last].astype(np.float64)
    if len(local) < 2:
        return 0.0
    return float(np.median(np.linalg.norm(np.diff(local, axis=0), axis=1)))


def paste_wave(
    image: Image.Image,
    draw: ImageDraw.ImageDraw,
    wave: Image.Image,
    x: int,
    y: int,
    label: str,
) -> None:
    draw.text((x, y), label, font=font(20), fill=INK)
    panel(image, (x, y + 32), wave.size)
    image.paste(wave, (x, y + 32))


def build_comparison(production: dict, features: dict) -> tuple[Image.Image, Image.Image, dict]:
    duration = float(production["current"]["waveform"]["duration"])
    overview_wave = production["current"]["waveform"]
    overview_amp = np.asarray(overview_wave["amp"], dtype=np.float64)
    overview_rgb = channel_matrix(overview_wave)

    detail_features_amp = candidate_source_amplitude(features)
    detail_features_rgb, _drum_gate, _vocal_gate = semantic_rgb(
        features["detail"], VARIANTS[1], "detail"
    )
    _, fast_overview_rgb = aggregate_to_count(
        detail_features_amp, detail_features_rgb, len(overview_amp)
    )
    candidate_overview_rgb, overview_novelty, _overview_blocks = multiscale_colour(
        overview_rgb,
        fast_overview_rgb,
        len(overview_amp) / duration,
        span_seconds=OVERVIEW_TEXTURE_SPAN_SECONDS,
        base_gain=OVERVIEW_TEXTURE_BASE_GAIN,
        block_gain=OVERVIEW_TEXTURE_BLOCK_GAIN,
    )

    detail_wave = production["current_detail"]["waveform"]
    detail_amp = np.asarray(detail_wave["amp"], dtype=np.float64)
    detail_rgb = channel_matrix(detail_wave)
    detail_transient = np.asarray(detail_wave["transient"], dtype=np.float64) / 255
    candidate_detail_rgb, detail_novelty, _detail_blocks = multiscale_colour(
        detail_rgb,
        detail_rgb,
        len(detail_amp) / duration,
        span_seconds=DETAIL_TEXTURE_SPAN_SECONDS,
        base_gain=DETAIL_TEXTURE_BASE_GAIN,
        block_gain=DETAIL_TEXTURE_BLOCK_GAIN,
    )

    current_overview_display = overview_palette(
        overview_rgb, saturation=0.94, low_dominance=0.97, cap=242
    )
    candidate_overview_display = overview_palette(
        candidate_overview_rgb,
        saturation=OVERVIEW_CANDIDATE_SATURATION,
        low_dominance=0.95,
        cap=238,
    )

    red_start, red_end, red_run = select_dominant_window(
        overview_rgb, overview_amp, 0, duration, 18.0
    )
    green_start, green_end, green_run = select_dominant_window(
        overview_rgb, overview_amp, 1, duration, 18.0
    )
    red_window = (red_start, red_end)
    green_window = (green_start, green_end)

    image = Image.new("RGB", (2048, 1130), PAPER)
    draw = ImageDraw.Draw(image)
    draw.text((72, 42), "メグメル · 当前波形 vs 段内纹理候选", font=font(40), fill=INK)
    draw.text(
        (72, 96),
        "同一首歌、同一高度、同一时间窗；候选只改变颜色表达，未接入软件",
        font=font(21),
        fill=MUTED,
    )

    full_width = 1770
    current_full_amp, current_full_rgb, _ = screen_columns(
        overview_amp,
        overview_rgb,
        duration,
        0,
        duration,
        full_width,
        amplitude_statistic="median",
    )
    candidate_full_amp, candidate_full_rgb, _ = screen_columns(
        overview_amp,
        candidate_overview_rgb,
        duration,
        0,
        duration,
        full_width,
        amplitude_statistic="median",
    )
    current_full_rgb = overview_palette(
        current_full_rgb, saturation=0.94, low_dominance=0.97, cap=242
    )
    candidate_full_rgb = overview_palette(
        candidate_full_rgb,
        saturation=OVERVIEW_CANDIDATE_SATURATION,
        low_dominance=0.95,
        cap=238,
    )
    current_full = render_hard_columns(
        current_full_amp,
        current_full_rgb,
        125,
        start=0,
        end=duration,
        tick=30,
        label=60,
    )
    candidate_full = render_hard_columns(
        candidate_full_amp,
        candidate_full_rgb,
        125,
        start=0,
        end=duration,
        tick=30,
        label=60,
    )
    paste_wave(image, draw, current_full, 206, 142, "当前生产版")
    paste_wave(image, draw, candidate_full, 206, 323, "候选 · 多尺度段内纹理")

    draw.line((72, 515, 1976, 515), fill=(213, 220, 229), width=1)
    draw.text(
        (72, 542),
        "18 秒结构色块放大：仍使用整曲预览资产",
        font=font(28),
        fill=INK,
    )
    local_width = 820
    local_height = 155
    local_columns = (("红色主域", red_window, 72), ("绿色主域", green_window, 1056))
    overview_panels: dict[str, dict] = {}
    for name, window, x in local_columns:
        start, end = window
        draw.text(
            (x, 590),
            f"{name}  {format_time(start, 1)}–{format_time(end, 1)}",
            font=font(23),
            fill=INK,
        )
        current_amp, current_rgb, _current_extras = screen_columns(
            overview_amp,
            overview_rgb,
            duration,
            start,
            end,
            local_width,
            amplitude_statistic="median",
        )
        candidate_amp, candidate_rgb, _candidate_extras = screen_columns(
            overview_amp,
            candidate_overview_rgb,
            duration,
            start,
            end,
            local_width,
            amplitude_statistic="median",
        )
        current_rgb = overview_palette(
            current_rgb, saturation=0.94, low_dominance=0.97, cap=242
        )
        candidate_rgb = overview_palette(
            candidate_rgb,
            saturation=OVERVIEW_CANDIDATE_SATURATION,
            low_dominance=0.95,
            cap=238,
        )
        current_local = render_hard_columns(
            current_amp,
            current_rgb,
            local_height,
            start=start,
            end=end,
            tick=0.5,
            label=1,
        )
        candidate_local = render_hard_columns(
            candidate_amp,
            candidate_rgb,
            local_height,
            start=start,
            end=end,
            tick=0.5,
            label=1,
        )
        paste_wave(image, draw, current_local, x, 630, "当前生产版")
        paste_wave(image, draw, candidate_local, x, 840, "候选 · 同主色内恢复短时变化")
        overview_panels[name] = {"start": start, "end": end}

    current_labels = np.argmax(current_overview_display, axis=1)
    candidate_labels = np.argmax(candidate_overview_display, axis=1)
    label_retention = float(np.mean(current_labels == candidate_labels))
    red_delta_current = median_adjacent_delta(current_overview_display, *red_run)
    red_delta_candidate = median_adjacent_delta(candidate_overview_display, *red_run)
    green_delta_current = median_adjacent_delta(current_overview_display, *green_run)
    green_delta_candidate = median_adjacent_delta(candidate_overview_display, *green_run)
    current_sat = median_saturation(current_overview_display)
    candidate_sat = median_saturation(candidate_overview_display)

    draw.text(
        (72, 1047),
        f"中位饱和度 {current_sat * 100:.0f}% → {candidate_sat * 100:.0f}%   ·   "
        f"主色方向保留 {label_retention * 100:.1f}%   ·   "
        f"红域段内色差 {red_delta_current:.1f} → {red_delta_candidate:.1f}   ·   "
        f"绿域 {green_delta_current:.1f} → {green_delta_candidate:.1f}",
        font=font(20),
        fill=INK,
    )
    draw.text(
        (72, 1085),
        "纹理来自相对 1.05 秒局部基线的真实短时频谱偏差；混色段增益很低，不叠加随机颗粒。",
        font=font(18),
        fill=MUTED,
    )

    metrics = {
        "schema": "kdj-waveform-intra-section-audit-v1",
        "production_modified": False,
        "source_path": production["source_path"],
        "duration": duration,
        "overview": {
            "current_median_saturation": current_sat,
            "candidate_median_saturation": candidate_sat,
            "dominant_channel_retention": label_retention,
            "red_run_adjacent_colour_delta": [red_delta_current, red_delta_candidate],
            "green_run_adjacent_colour_delta": [green_delta_current, green_delta_candidate],
        },
        "overview_windows": overview_panels,
        "candidate": {
            "overview_texture_gain": [
                OVERVIEW_TEXTURE_BASE_GAIN,
                OVERVIEW_TEXTURE_BLOCK_GAIN,
            ],
            "detail_texture_gain": [DETAIL_TEXTURE_BASE_GAIN, DETAIL_TEXTURE_BLOCK_GAIN],
            "overview_saturation_retention": OVERVIEW_CANDIDATE_SATURATION,
            "detail_saturation_retention": DETAIL_CANDIDATE_SATURATION,
        },
    }
    mobile = Image.new("RGB", (520, 1390), PAPER)
    mobile_draw = ImageDraw.Draw(mobile)
    mobile_draw.text((28, 28), "メグメル · 当前 vs 候选", font=font(28), fill=INK)
    mobile_draw.text(
        (28, 70),
        "同一高度与时间窗 · 候选未接入",
        font=font(18),
        fill=MUTED,
    )
    mobile_width = 464
    mobile_current_amp, mobile_current_rgb, _ = screen_columns(
        overview_amp,
        overview_rgb,
        duration,
        0,
        duration,
        mobile_width,
        amplitude_statistic="median",
    )
    mobile_candidate_amp, mobile_candidate_rgb, _ = screen_columns(
        overview_amp,
        candidate_overview_rgb,
        duration,
        0,
        duration,
        mobile_width,
        amplitude_statistic="median",
    )
    mobile_current_rgb = overview_palette(
        mobile_current_rgb, saturation=0.94, low_dominance=0.97, cap=242
    )
    mobile_candidate_rgb = overview_palette(
        mobile_candidate_rgb,
        saturation=OVERVIEW_CANDIDATE_SATURATION,
        low_dominance=0.95,
        cap=238,
    )
    paste_wave(
        mobile,
        mobile_draw,
        render_hard_columns(
            mobile_current_amp,
            mobile_current_rgb,
            100,
            start=0,
            end=duration,
            tick=60,
            label=120,
        ),
        28,
        108,
        "当前生产版",
    )
    paste_wave(
        mobile,
        mobile_draw,
        render_hard_columns(
            mobile_candidate_amp,
            mobile_candidate_rgb,
            100,
            start=0,
            end=duration,
            tick=60,
            label=120,
        ),
        28,
        258,
        "候选 · 多尺度段内纹理",
    )

    mobile_y = 425
    for name, (start, end), _x in local_columns:
        mobile_draw.text(
            (28, mobile_y),
            f"{name}  {format_time(start, 1)}–{format_time(end, 1)}",
            font=font(21),
            fill=INK,
        )
        current_amp, current_rgb, _ = screen_columns(
            overview_amp,
            overview_rgb,
            duration,
            start,
            end,
            mobile_width,
            amplitude_statistic="median",
        )
        candidate_amp, candidate_rgb, _ = screen_columns(
            overview_amp,
            candidate_overview_rgb,
            duration,
            start,
            end,
            mobile_width,
            amplitude_statistic="median",
        )
        current_rgb = overview_palette(
            current_rgb, saturation=0.94, low_dominance=0.97, cap=242
        )
        candidate_rgb = overview_palette(
            candidate_rgb,
            saturation=OVERVIEW_CANDIDATE_SATURATION,
            low_dominance=0.95,
            cap=238,
        )
        paste_wave(
            mobile,
            mobile_draw,
            render_hard_columns(
                current_amp,
                current_rgb,
                115,
                start=start,
                end=end,
                tick=2,
                label=6,
            ),
            28,
            mobile_y + 38,
            "当前",
        )
        paste_wave(
            mobile,
            mobile_draw,
            render_hard_columns(
                candidate_amp,
                candidate_rgb,
                115,
                start=start,
                end=end,
                tick=2,
                label=6,
            ),
            28,
            mobile_y + 203,
            "候选",
        )
        mobile_y += 385

    mobile_draw.text(
        (28, 1212),
        f"饱和度 {current_sat * 100:.0f}% → {candidate_sat * 100:.0f}%",
        font=font(19),
        fill=INK,
    )
    mobile_draw.text(
        (28, 1248),
        f"主色方向保留 {label_retention * 100:.1f}%",
        font=font(19),
        fill=INK,
    )
    mobile_draw.text(
        (28, 1284),
        f"红域色差 {red_delta_current:.1f} → {red_delta_candidate:.1f}  ·  "
        f"绿域 {green_delta_current:.1f} → {green_delta_candidate:.1f}",
        font=font(18),
        fill=INK,
    )
    mobile_draw.text(
        (28, 1330),
        "真实短时频谱偏差 · 无随机颗粒",
        font=font(18),
        fill=MUTED,
    )
    return image, mobile, metrics


def encoded_png(image: Image.Image) -> str:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return base64.b64encode(buffer.getvalue()).decode("ascii")


def html_fragment(image: Image.Image, mobile: Image.Image, metrics: dict) -> str:
    encoded = encoded_png(image)
    mobile_encoded = encoded_png(mobile)
    title = "メグメル · 当前与段内纹理候选"
    summary = (
        f"同一几何对比。候选中位饱和度为"
        f"{metrics['overview']['candidate_median_saturation'] * 100:.0f}%，"
        f"并保留 {metrics['overview']['dominant_channel_retention'] * 100:.1f}% 的主色方向。"
    )
    return f'''<div id="kdj-waveform-texture-comparison-v1">
  <h2>{title}</h2>
  <p class="text-muted">{summary}</p>
  <picture>
    <source media="(max-width: 520px)" srcset="data:image/png;base64,{mobile_encoded}">
    <img src="data:image/png;base64,{encoded}" alt="メグメル当前生产波形与段内纹理候选的整曲预览、红色主域和绿色主域对比。候选保持相同高度与时间窗，降低饱和度并显示真实短时频谱细节。">
  </picture>
</div>
<style>
  #kdj-waveform-texture-comparison-v1 {{ width: 100%; color: var(--foreground); }}
  #kdj-waveform-texture-comparison-v1 h2 {{ margin: 0 0 0.35rem; font-weight: 500; }}
  #kdj-waveform-texture-comparison-v1 p {{ margin: 0 0 0.75rem; }}
  #kdj-waveform-texture-comparison-v1 picture,
  #kdj-waveform-texture-comparison-v1 img {{ display: block; width: 100%; height: auto; }}
</style>
'''


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("production", type=Path)
    parser.add_argument("features", type=Path)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("visualization", type=Path)
    args = parser.parse_args()

    production = json.loads(args.production.read_text())
    features = json.loads(args.features.read_text())
    if production.get("schema") != "kdj-waveform-structure-audit-v2":
        raise ValueError("production JSON 不是 waveform structure audit v2")
    if features.get("schema") != "kdj-waveform-pure-dsp-audit-v2":
        raise ValueError("features JSON 不是 pure DSP audit v2")

    image, mobile, metrics = build_comparison(production, features)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    image_path = args.output_dir / "megumeru-current-vs-intra-section-candidate.png"
    mobile_path = args.output_dir / "megumeru-current-vs-intra-section-candidate-mobile.png"
    metrics_path = args.output_dir / "metrics.json"
    image.save(image_path, optimize=True)
    mobile.save(mobile_path, optimize=True)
    metrics["artifacts"] = {
        "image": str(image_path),
        "mobile_image": str(mobile_path),
        "visualization": str(args.visualization),
    }
    metrics_path.write_text(json.dumps(metrics, ensure_ascii=False, indent=2) + "\n")

    args.visualization.parent.mkdir(parents=True, exist_ok=True)
    args.visualization.write_text(html_fragment(image, mobile, metrics))
    print(json.dumps(metrics, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
