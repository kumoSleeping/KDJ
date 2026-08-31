#!/usr/bin/env python3
"""Render three audit-only semantic colour strengths over the pure-DSP waveform.

Geometry is identical in every row. Only the contribution of measured evidence changes:
low-frequency transients, mid-band periodic/harmonic energy, and high-frequency transients form
the three colour coordinates. No target hue, stem, or classifier output is used.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

from render_waveform_structure_audit import (
    BORDER,
    INK,
    MUTED,
    PANEL,
    PAPER,
    aggregate_columns,
    candidate_overview_palette,
    clamp,
    count_label,
    font,
    format_time,
    hard_interval_columns,
    moving_average,
    panel,
    render_hard_columns,
    select_windows,
)


VARIANTS = (
    {
        "key": "A",
        "name": "频谱优先",
        "note": "分析色只轻度进入结果，原始频带底色占主导",
        "detail_mix": 0.27,
        "overview_mix": 0.12,
    },
    {
        "key": "B",
        "name": "叠加平衡（推荐）",
        "note": "分析色与频带底色等权协作，峰柱可辨但不覆盖事实",
        "detail_mix": 0.46,
        "overview_mix": 0.24,
    },
    {
        "key": "C",
        "name": "DJ 高辨识",
        "note": "提高同一分析色的融合比例，识别最快但语义权重更大",
        "detail_mix": 0.66,
        "overview_mix": 0.39,
    },
)

AXIS_LOW = (235, 62, 50)
AXIS_MID = (46, 188, 92)
AXIS_HIGH = (55, 132, 235)


def srgb_to_linear(rgb: np.ndarray) -> np.ndarray:
    normalised = np.clip(np.asarray(rgb, dtype=np.float64) / 255, 0, 1)
    return np.where(
        normalised <= 0.04045,
        normalised / 12.92,
        np.power((normalised + 0.055) / 1.055, 2.4),
    )


def linear_to_srgb(rgb: np.ndarray) -> np.ndarray:
    linear = np.clip(np.asarray(rgb, dtype=np.float64), 0, 1)
    normalised = np.where(
        linear <= 0.0031308,
        linear * 12.92,
        1.055 * np.power(linear, 1 / 2.4) - 0.055,
    )
    return np.rint(normalised * 255).clip(0, 255).astype(np.uint8)


def semantic_rgb(block: dict, variant: dict, view: str) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    base_rgb = np.column_stack((block["r"], block["g"], block["b"])).astype(np.float64)
    base_linear = srgb_to_linear(base_rgb)
    drum_core = np.asarray(block["drum_core"], dtype=np.float64)
    vocal = np.asarray(block["vocal_like"], dtype=np.float64)

    drum_gate = np.power(np.clip((drum_core - 0.16) / 0.84, 0, 1), 0.72)
    vocal_gate = np.power(np.clip((vocal - 0.22) / 0.78, 0, 1), 1.10)
    semantic = np.column_stack(
        (
            np.asarray(block["semantic_low"], dtype=np.float64),
            np.asarray(block["semantic_mid"], dtype=np.float64),
            np.asarray(block["semantic_high"], dtype=np.float64),
        )
    )
    semantic_peak = np.max(semantic, axis=1)
    semantic_normalised = semantic / np.maximum(semantic_peak[:, None], 1e-9)
    semantic_linear = srgb_to_linear(semantic_normalised * 255)
    reliability = 1.0 - (1.0 - drum_gate) * (1.0 - vocal_gate)
    mix_weight = variant[f"{view}_mix"] * reliability
    # The measured low/mid-harmonic/high evidence vector is used directly as three colour
    # coordinates. Variants change only its participation in the final linear-light mixture.
    mixed = base_linear * (1.0 - mix_weight[:, None])
    mixed += semantic_linear * mix_weight[:, None]
    return linear_to_srgb(mixed), drum_gate, vocal_gate


def candidate_source_amplitude(features: dict) -> np.ndarray:
    base = np.asarray(features["detail"]["amp"], dtype=np.float64)
    drum = np.asarray(features["detail"]["drum"], dtype=np.float64)
    feature_hz = float(features["feature_hz"])
    slow_level = moving_average(base, max(3, round(feature_hz * 0.18)) | 1)
    wall_strength = np.clip((slow_level - 0.52) / 0.36, 0.0, 1.0)
    contrast_base = np.power(np.clip(base, 0.0, 1.0), 1.0 + 1.8 * wall_strength)
    return contrast_base + (1.0 - contrast_base) * 0.66 * np.power(drum, 0.86)


def detail_variant_columns(
    features: dict,
    variant: dict,
    start: float,
    end: float,
    width: int,
) -> tuple[np.ndarray, np.ndarray, dict[str, float]]:
    source_amp = candidate_source_amplitude(features)
    source_rgb, drum_gate, vocal_gate = semantic_rgb(features["detail"], variant, "detail")
    amplitude, rgb = hard_interval_columns(
        source_amp,
        source_rgb,
        float(features["duration"]),
        start,
        end,
        width,
    )
    first = max(0, math.floor(start * float(features["feature_hz"])))
    last = min(len(source_amp), max(first + 1, math.ceil(end * float(features["feature_hz"]))))
    local_gate = drum_gate[first:last]
    local_rgb = source_rgb[first:last].astype(np.float64)
    core_indices = np.flatnonzero(local_gate >= 0.20)
    colour_deltas: list[float] = []
    for index in core_indices:
        neighbours = []
        if index >= 2:
            neighbours.append(local_rgb[index - 2])
        if index + 2 < len(local_rgb):
            neighbours.append(local_rgb[index + 2])
        if neighbours:
            colour_deltas.append(
                float(np.linalg.norm(local_rgb[index] - np.mean(neighbours, axis=0)))
                / math.sqrt(3 * 255**2)
            )
    local_vocal = vocal_gate[first:last]
    return amplitude, rgb, {
        "drum_colour_delta": float(np.median(colour_deltas)) if colour_deltas else 0.0,
        "strong_core_columns": int(np.count_nonzero(local_gate >= 0.20)),
        "vocal_active_share": float(np.mean(local_vocal >= 0.25)),
    }


def overview_variant(features: dict, variant: dict, width: int) -> tuple[np.ndarray, np.ndarray]:
    block = features["overview"]
    amplitude = np.asarray(block["amp"], dtype=np.float64)
    source_rgb, _drum, _vocal = semantic_rgb(block, variant, "overview")
    return aggregate_columns(
        amplitude,
        source_rgb,
        width,
        statistic="median",
        palette=candidate_overview_palette,
    )


def paste_wave(canvas: Image.Image, wave: Image.Image, location: tuple[int, int]) -> None:
    panel(canvas, location, wave.size)
    canvas.paste(wave, location)


def draw_legend(draw: ImageDraw.ImageDraw, y: int) -> None:
    entries = (
        ("低频瞬态 R", AXIS_LOW),
        ("中频周期 G", AXIS_MID),
        ("高频瞬态 B", AXIS_HIGH),
    )
    x = 1920
    for label, colour in entries:
        draw.rectangle((x, y + 4, x + 22, y + 26), fill=colour)
        draw.text((x + 34, y), label, font=font(22), fill=MUTED)
        x += 430


def render_overview(features_list: list[dict], output: Path) -> None:
    image_height = 210 + len(features_list) * 750 + 90
    image = Image.new("RGB", (3600, image_height), PAPER)
    draw = ImageDraw.Draw(image)
    draw.text(
        (180, 52),
        f"{count_label(len(features_list))}首歌：语义叠加配色三档 · 整曲预览",
        font=font(56),
        fill=INK,
    )
    draw.text((180, 128), "三档几何完全相同，只比较分析命中的颜色权重", font=font(27), fill=MUTED)
    draw_legend(draw, 126)
    width = 1600
    for song_index, features in enumerate(features_list):
        block_top = 205 + song_index * 750
        duration = float(features["duration"])
        draw.text(
            (180, block_top),
            f"{song_index + 1}. {features['title']}",
            font=font(35),
            fill=INK,
        )
        draw.text((3150, block_top + 5), format_time(duration), font=font(24), fill=MUTED)
        for row_index, variant in enumerate(VARIANTS):
            y = block_top + 55 + row_index * 217
            draw.text(
                (180, y),
                f"{variant['key']} · {variant['name']}",
                font=font(26),
                fill=INK,
            )
            draw.text((650, y + 2), variant["note"], font=font(21), fill=MUTED)
            amplitude, rgb = overview_variant(features, variant, width)
            wave = render_hard_columns(
                np.repeat(amplitude, 2),
                np.repeat(rgb, 2, axis=0),
                132,
                start=0,
                end=duration,
                tick=30,
                label=60,
            )
            paste_wave(image, wave, (180, y + 38))
    draw.text(
        (180, image_height - 52),
        "底层仍是 γ6 低 / 中 / 高频结构色；语义层只叠加，不替换原始分析。",
        font=font(22),
        fill=MUTED,
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    image.save(output, optimize=True)


def render_detail(features_list: list[dict], output: Path) -> dict:
    image_height = 205 + len(features_list) * 845 + 90
    image = Image.new("RGB", (3600, image_height), PAPER)
    draw = ImageDraw.Draw(image)
    draw.text(
        (180, 52),
        f"{count_label(len(features_list))}首歌：语义叠加配色三档 · 4 秒细节",
        font=font(56),
        fill=INK,
    )
    draw.text(
        (180, 128),
        "低／高频瞬态只写入命中的核心源柱；中频周期证据可持续；高度与时间窗完全相同",
        font=font(27),
        fill=MUTED,
    )
    draw_legend(draw, 126)
    width = 3200
    report: dict[str, dict] = {}
    for song_index, features in enumerate(features_list):
        block_top = 200 + song_index * 845
        _context_start, _context_end, zoom_start, zoom_end = select_windows(features)
        title = features["title"]
        draw.text(
            (180, block_top),
            f"{song_index + 1}. {title}  ·  {format_time(zoom_start, 1)}–{format_time(zoom_end, 1)}",
            font=font(34),
            fill=INK,
        )
        report[title] = {}
        for row_index, variant in enumerate(VARIANTS):
            y = block_top + 48 + row_index * 260
            amplitude, rgb, metrics = detail_variant_columns(
                features, variant, zoom_start, zoom_end, width
            )
            report[title][variant["key"]] = metrics
            draw.text(
                (180, y),
                f"{variant['key']} · {variant['name']}",
                font=font(25),
                fill=INK,
            )
            draw.text(
                (750, y + 2),
                f"鼓峰对邻柱中位色差 {metrics['drum_colour_delta'] * 100:.0f}%",
                font=font(21),
                fill=MUTED,
            )
            wave = render_hard_columns(
                amplitude,
                rgb,
                210,
                start=zoom_start,
                end=zoom_end,
                tick=0.5,
                label=1,
            )
            paste_wave(image, wave, (180, y + 36))
    draw.text(
        (180, image_height - 52),
        "同一时刻的低频瞬态、中频周期与高频瞬态按实测比例合成，不指定目标颜色。",
        font=font(22),
        fill=MUTED,
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    image.save(output, optimize=True)
    return report


def render_stress_crop(features: dict, output: Path) -> None:
    image = Image.new("RGB", (3600, 930), PAPER)
    draw = ImageDraw.Draw(image)
    _context_start, _context_end, zoom_start, zoom_end = select_windows(features)
    draw.text(
        (180, 42),
        f"Jumping Heart 噪声墙压力样本 · {format_time(zoom_start, 1)}–{format_time(zoom_end, 1)}",
        font=font(47),
        fill=INK,
    )
    draw_legend(draw, 103)
    width = 3200
    for row_index, variant in enumerate(VARIANTS):
        y = 105 + row_index * 265
        amplitude, rgb, metrics = detail_variant_columns(
            features, variant, zoom_start, zoom_end, width
        )
        draw.text(
            (180, y),
            f"{variant['key']} · {variant['name']}",
            font=font(25),
            fill=INK,
        )
        draw.text(
            (740, y + 2),
            f"命中鼓峰对邻柱中位色差 {metrics['drum_colour_delta'] * 100:.0f}%",
            font=font(21),
            fill=MUTED,
        )
        wave = render_hard_columns(
            amplitude,
            rgb,
            210,
            start=zoom_start,
            end=zoom_end,
            tick=0.5,
            label=1,
        )
        paste_wave(image, wave, (180, y + 36))
    output.parent.mkdir(parents=True, exist_ok=True)
    image.save(output, optimize=True)


def select_micro_window(features: dict, seconds: float = 1.2) -> tuple[float, float]:
    _context_start, _context_end, zoom_start, zoom_end = select_windows(features)
    hz = float(features["feature_hz"])
    drum = np.asarray(features["detail"]["drum_core"], dtype=np.float64)
    mid = np.asarray(features["detail"]["semantic_mid"], dtype=np.float64)
    first = max(0, math.floor(zoom_start * hz))
    last = min(len(drum), math.ceil(zoom_end * hz))
    length = max(1, round(seconds * hz))
    local = np.power(drum[first:last], 0.72) + 0.18 * mid[first:last]
    if len(local) <= length:
        return zoom_start, min(zoom_end, zoom_start + seconds)
    cumulative = np.concatenate(([0.0], np.cumsum(local, dtype=np.float64)))
    sums = cumulative[length:] - cumulative[:-length]
    index = first + int(np.argmax(sums))
    return index / hz, min(float(features["duration"]), (index + length) / hz)


def render_micro_board(features_list: list[dict], stress: dict, output: Path) -> None:
    representatives = [features_list[0], stress]
    image = Image.new("RGB", (3600, 1890), PAPER)
    draw = ImageDraw.Draw(image)
    draw.text((180, 42), "1.2 秒柱色放大：分析色是否只落在命中柱", font=font(48), fill=INK)
    draw.text(
        (180, 103),
        "只是放大显示；仍使用同一 400 列/秒特征，没有重新插值或加粗峰柱",
        font=font(24),
        fill=MUTED,
    )
    draw_legend(draw, 101)
    width = 3200
    for song_index, features in enumerate(representatives):
        block_top = 155 + song_index * 845
        start, end = select_micro_window(features)
        draw.text(
            (180, block_top),
            f"{features['title']}  ·  {format_time(start, 1)}–{format_time(end, 1)}",
            font=font(31),
            fill=INK,
        )
        for row_index, variant in enumerate(VARIANTS):
            y = block_top + 45 + row_index * 260
            amplitude, rgb, metrics = detail_variant_columns(features, variant, start, end, width)
            draw.text(
                (180, y),
                f"{variant['key']} · {variant['name']}",
                font=font(24),
                fill=INK,
            )
            draw.text(
                (750, y + 2),
                f"命中柱对邻柱中位色差 {metrics['drum_colour_delta'] * 100:.0f}%",
                font=font(20),
                fill=MUTED,
            )
            wave = render_hard_columns(
                amplitude,
                rgb,
                210,
                start=start,
                end=end,
                tick=0.2,
                label=0.4,
            )
            paste_wave(image, wave, (180, y + 34))
    output.parent.mkdir(parents=True, exist_ok=True)
    image.save(output, optimize=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--features", action="append", type=Path, required=True)
    args = parser.parse_args()
    features_list = [json.loads(path.read_text()) for path in args.features]
    for features in features_list:
        if features.get("schema") != "kdj-waveform-pure-dsp-audit-v2":
            raise ValueError(f"需要 v2 纯 DSP 特征：{features.get('source_path', 'unknown')}")
    stress = next(
        (
            features
            for features in features_list
            if "sh1ne core" in features["title"].casefold()
            or "shine core" in features["title"].casefold()
        ),
        None,
    )
    if stress is None:
        raise ValueError("缺少 Jumping Heart Sh1ne core 压力样本")

    args.output_dir.mkdir(parents=True, exist_ok=True)
    overview_path = args.output_dir / "semantic-colour-variants-overview-4songs.png"
    detail_path = args.output_dir / "semantic-colour-variants-detail-4songs.png"
    stress_path = args.output_dir / "semantic-colour-variants-jumping-heart.png"
    micro_path = args.output_dir / "semantic-colour-variants-micro-2songs.png"
    render_overview(features_list, overview_path)
    detail_report = render_detail(features_list, detail_path)
    render_stress_crop(stress, stress_path)
    render_micro_board(features_list, stress, micro_path)
    report = {
        "schema": "kdj-waveform-semantic-colour-variants-v1",
        "production_modified": False,
        "variants": VARIANTS,
        "detail_metrics": detail_report,
        "artifacts": {
            "overview": str(overview_path),
            "detail": str(detail_path),
            "stress": str(stress_path),
            "micro": str(micro_path),
        },
    }
    report_path = args.output_dir / "metrics-semantic-colour-variants-v1.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
