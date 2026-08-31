#!/usr/bin/env python3
"""Extract audit-only, non-STEM waveform features from a real song.

This tool deliberately lives outside the Tauri runtime.  It decodes one file with ffmpeg and
produces a high-density pixel-column envelope plus hand-crafted onset features.  No source
separation model is loaded and no production cache is modified.

The onset detector follows the classical spectral-flux family: positive log-spectrum changes,
frequency-axis maximum filtering (SuperFlux-style vibrato suppression), band-specific evidence,
and adaptive peak selection.  Detected percussion raises only the matching transient columns.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import shutil
import subprocess

import numpy as np


SAMPLE_RATE = 44_100
N_FFT = 2_048
HOP = 256
LAG = 2
FREQUENCY_MAX_RADIUS = 2
DETAIL_COLUMNS_PER_SECOND = 400.0
OVERVIEW_COLUMNS = 4_096
COLOR_FLOOR_DETAIL = 0.06
COLOR_GAMMA_DETAIL = 2.4
COLOR_FLOOR_OVERVIEW = 0.12
COLOR_GAMMA_OVERVIEW = 6.0


def decode_mono(path: Path) -> np.ndarray:
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        raise RuntimeError("找不到 ffmpeg，无法解码真实歌曲")
    command = [
        ffmpeg,
        "-v",
        "error",
        "-i",
        str(path),
        "-map_metadata",
        "-1",
        "-vn",
        "-ac",
        "1",
        "-ar",
        str(SAMPLE_RATE),
        "-f",
        "f32le",
        "pipe:1",
    ]
    result = subprocess.run(command, check=True, stdout=subprocess.PIPE)
    samples = np.frombuffer(result.stdout, dtype="<f4").astype(np.float32, copy=True)
    if samples.size == 0:
        raise RuntimeError(f"解码结果为空：{path}")
    return samples


def moving_average(values: np.ndarray, span: int) -> np.ndarray:
    if span <= 1:
        return values.astype(np.float64, copy=True)
    span = min(span, len(values))
    left = span // 2
    right = span - 1 - left
    padded = np.pad(values.astype(np.float64), (left, right), mode="edge")
    cumulative = np.concatenate(([0.0], np.cumsum(padded, dtype=np.float64)))
    return (cumulative[span:] - cumulative[:-span]) / span


def frequency_maximum(values: np.ndarray, radius: int) -> np.ndarray:
    """Maximum-filter spectra along frequency without a scipy dependency."""
    output = values.copy()
    for shift in range(1, radius + 1):
        output[:, shift:] = np.maximum(output[:, shift:], values[:, :-shift])
        output[:, :-shift] = np.maximum(output[:, :-shift], values[:, shift:])
    return output


def band_mean(values: np.ndarray, frequencies: np.ndarray, low: float, high: float) -> np.ndarray:
    mask = (frequencies >= low) & (frequencies < high)
    if not np.any(mask):
        return np.zeros(values.shape[0], dtype=np.float64)
    return np.mean(values[:, mask], axis=1, dtype=np.float64)


def robust_novelty(values: np.ndarray, frame_hz: float) -> np.ndarray:
    """Track-normalise a detection function while rejecting its slow local floor."""
    source = np.maximum(np.asarray(values, dtype=np.float64), 0.0)
    compressed = np.log1p(source / max(float(np.quantile(source, 0.55)), 1e-12))
    local_floor = moving_average(compressed, max(3, round(frame_hz * 0.24)) | 1)
    residual = np.maximum(compressed - 0.42 * local_floor, 0.0)
    low = float(np.quantile(residual, 0.60))
    high = float(np.quantile(residual, 0.997))
    return np.clip((residual - low) / max(high - low, 1e-12), 0.0, 1.0)


def local_maximum_mask(values: np.ndarray, radius: int) -> np.ndarray:
    maximum = values.copy()
    for shift in range(1, radius + 1):
        maximum[shift:] = np.maximum(maximum[shift:], values[:-shift])
        maximum[:-shift] = np.maximum(maximum[:-shift], values[shift:])
    return values >= maximum - 1e-12


def analyse_spectra(samples: np.ndarray) -> dict[str, np.ndarray | float]:
    padded_count = max(N_FFT, len(samples))
    frame_count = 1 + math.ceil(max(0, padded_count - N_FFT) / HOP)
    required = (frame_count - 1) * HOP + N_FFT
    padded = np.pad(samples, (0, max(0, required - len(samples))))
    window = np.hanning(N_FFT).astype(np.float32)
    frequencies = np.fft.rfftfreq(N_FFT, 1 / SAMPLE_RATE)
    frame_hz = SAMPLE_RATE / HOP

    names = (
        "flux_low",
        "flux_body",
        "flux_attack",
        "flux_high",
        "flux_broad",
        "hfc",
        "energy_attack",
        "energy_low",
        "energy_mid",
        "energy_high",
        "energy_total",
        "voice_mid_share",
        "spectral_flatness_mid",
        "periodicity",
    )
    output = {name: np.zeros(frame_count, dtype=np.float64) for name in names}
    history = np.zeros((LAG, N_FFT // 2 + 1), dtype=np.float32)
    previous_log_energy = 0.0
    batch_size = 512

    for batch_start in range(0, frame_count, batch_size):
        batch_end = min(frame_count, batch_start + batch_size)
        frame_indices = (
            np.arange(batch_start, batch_end, dtype=np.int64)[:, None] * HOP
            + np.arange(N_FFT, dtype=np.int64)[None, :]
        )
        frames = padded[frame_indices] * window
        spectrum = np.abs(np.fft.rfft(frames, axis=1)).astype(np.float32)
        power = np.square(spectrum, dtype=np.float32)
        # Per-frame normalisation makes the change measure less hostage to master loudness.
        scale = np.maximum(np.mean(spectrum, axis=1, keepdims=True), 1e-9)
        log_spectrum = np.log1p(spectrum / scale).astype(np.float32)
        combined = np.concatenate((history, log_spectrum), axis=0)
        previous = frequency_maximum(combined[:-LAG], FREQUENCY_MAX_RADIUS)
        difference = np.maximum(combined[LAG:] - previous, 0.0)
        if batch_start == 0:
            difference[:LAG] = 0.0
        history = log_spectrum[-LAG:].copy()

        selection = slice(batch_start, batch_end)
        output["flux_low"][selection] = band_mean(difference, frequencies, 35, 190)
        output["flux_body"][selection] = band_mean(difference, frequencies, 150, 1_400)
        output["flux_attack"][selection] = band_mean(difference, frequencies, 1_800, 8_000)
        output["flux_high"][selection] = band_mean(difference, frequencies, 6_000, 16_000)
        output["flux_broad"][selection] = band_mean(difference, frequencies, 35, 16_000)
        hfc_weight = np.sqrt(np.clip(frequencies / 8_000, 0.0, 2.0))
        output["hfc"][selection] = np.mean(difference * hfc_weight[None, :], axis=1)

        total_energy = np.sqrt(np.mean(power, axis=1, dtype=np.float64))
        log_energy = np.log1p(total_energy)
        previous_energy = np.concatenate(([previous_log_energy], log_energy[:-1]))
        output["energy_attack"][selection] = np.maximum(log_energy - previous_energy, 0.0)
        previous_log_energy = float(log_energy[-1])
        output["energy_low"][selection] = np.sqrt(
            band_mean(power, frequencies, 35, 200)
        )
        output["energy_mid"][selection] = np.sqrt(
            band_mean(power, frequencies, 200, 1_500)
        )
        output["energy_high"][selection] = np.sqrt(
            band_mean(power, frequencies, 1_500, 16_000)
        )
        output["energy_total"][selection] = total_energy

        voice_mask = (frequencies >= 180) & (frequencies < 5_000)
        audible_mask = (frequencies >= 35) & (frequencies < 16_000)
        voice_power = np.maximum(power[:, voice_mask].astype(np.float64), 1e-16)
        output["voice_mid_share"][selection] = np.sum(voice_power, axis=1) / np.maximum(
            np.sum(power[:, audible_mask], axis=1, dtype=np.float64), 1e-16
        )
        output["spectral_flatness_mid"][selection] = np.exp(
            np.mean(np.log(voice_power), axis=1)
        ) / np.maximum(np.mean(voice_power, axis=1), 1e-16)

        # Normalised autocorrelation peak in the broad sung-pitch range. This is only a
        # periodic/harmonic likelihood: guitars and synth leads can legitimately score too.
        autocorrelation = np.fft.irfft(power, n=N_FFT, axis=1)
        lag_low = max(1, math.floor(SAMPLE_RATE / 420))
        lag_high = min(N_FFT // 2, math.ceil(SAMPLE_RATE / 75))
        output["periodicity"][selection] = np.clip(
            np.max(autocorrelation[:, lag_low:lag_high], axis=1)
            / np.maximum(autocorrelation[:, 0], 1e-16),
            0.0,
            1.0,
        )

    low = robust_novelty(output["flux_low"], frame_hz)
    body = robust_novelty(output["flux_body"], frame_hz)
    attack = robust_novelty(output["flux_attack"], frame_hz)
    high = robust_novelty(output["flux_high"], frame_hz)
    broad = robust_novelty(output["flux_broad"], frame_hz)
    hfc = robust_novelty(output["hfc"], frame_hz)
    energy_attack = robust_novelty(output["energy_attack"], frame_hz)

    # These are evidence scores, not separated stems.  The overlapping formulations retain
    # mixed events (for example kick + cymbal) instead of forcing one winning class.
    kick = np.clip(0.55 * low + 0.27 * broad + 0.18 * energy_attack, 0.0, 1.0)
    snare = np.clip(0.34 * body + 0.46 * attack + 0.20 * broad, 0.0, 1.0)
    hat = np.clip(0.64 * high + 0.36 * hfc, 0.0, 1.0)
    combined = np.maximum.reduce((kick, snare, 0.82 * hat))

    adaptive = 0.58 * moving_average(combined, max(3, round(frame_hz * 0.20)) | 1)
    adaptive += 0.42 * float(np.quantile(combined, 0.62))
    ceiling = float(np.quantile(combined, 0.997))
    strength = np.clip((combined - adaptive) / np.maximum(ceiling - adaptive, 1e-9), 0.0, 1.0)
    peak_mask = local_maximum_mask(combined, 2)
    strength = np.where(peak_mask & (strength >= 0.10), strength, 0.0)
    # Avoid false first-frame clicks and the padded tail.
    strength[:4] = 0.0
    strength[-4:] = 0.0

    periodicity = np.asarray(output["periodicity"], dtype=np.float64)
    periodicity = np.clip(
        (periodicity - float(np.quantile(periodicity, 0.25)))
        / max(
            float(np.quantile(periodicity, 0.975) - np.quantile(periodicity, 0.25)),
            1e-9,
        ),
        0.0,
        1.0,
    )
    tonality = np.clip(
        (0.52 - np.asarray(output["spectral_flatness_mid"], dtype=np.float64)) / 0.50,
        0.0,
        1.0,
    )
    mid_share = np.clip(
        (np.asarray(output["voice_mid_share"], dtype=np.float64) - 0.18) / 0.62,
        0.0,
        1.0,
    )
    total_energy = np.log1p(np.asarray(output["energy_total"], dtype=np.float64))
    energy_low = float(np.quantile(total_energy, 0.10))
    energy_high = float(np.quantile(total_energy, 0.92))
    energy_gate = np.clip((total_energy - energy_low) / max(energy_high - energy_low, 1e-9), 0, 1)
    sustained = 1.0 - 0.58 * np.sqrt(np.clip(broad, 0.0, 1.0))
    vocal_like = (
        np.power(periodicity, 0.72)
        * np.power(tonality, 0.55)
        * np.power(mid_share, 0.62)
        * np.power(energy_gate, 0.45)
        * sustained
    )
    vocal_like = moving_average(vocal_like, max(3, round(frame_hz * 0.080)) | 1)
    vocal_low = float(np.quantile(vocal_like, 0.35))
    vocal_high = float(np.quantile(vocal_like, 0.975))
    vocal_like = np.clip(
        (vocal_like - vocal_low) / max(vocal_high - vocal_low, 1e-9), 0.0, 1.0
    )

    output.update(
        {
            "frame_hz": frame_hz,
            "kick": kick * strength,
            "snare": snare * strength,
            "hat": hat * strength,
            "drum": strength,
            "vocal_like": vocal_like,
            # Semantic colour axes are measured evidence, not target hues: low-frequency
            # transient change, sustained mid/harmonic periodicity, high-frequency transient
            # change. The renderer maps these three orthogonal values to RGB consistently.
            "semantic_low": np.clip((0.82 * low + 0.18 * body) * strength, 0.0, 1.0),
            "semantic_high": np.clip(
                np.maximum.reduce((attack, high, hfc)) * strength, 0.0, 1.0
            ),
        }
    )
    return output


def pixel_envelope(samples: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    duration = len(samples) / SAMPLE_RATE
    count = max(1, math.ceil(duration * DETAIL_COLUMNS_PER_SECOND))
    # The display cadence is 2.5 ms, but a 2.5 ms amplitude window exposes carrier-phase jitter
    # as meaningless hair.  A 10 ms overlapping measurement is still much shorter than a drum
    # beat/attack, while keeping the independently rendered 400 Hz time grid.
    window_size = min(len(samples), max(1, round(SAMPLE_RATE * 0.010)))
    centres = np.floor(
        (np.arange(count, dtype=np.float64) + 0.5)
        * SAMPLE_RATE
        / DETAIL_COLUMNS_PER_SECOND
    ).astype(np.int64)
    starts = np.clip(centres - window_size // 2, 0, max(0, len(samples) - window_size))
    ends = starts + window_size
    absolute = np.abs(samples).astype(np.float64)
    squared = np.square(samples, dtype=np.float64)
    cumulative = np.concatenate(([0.0], np.cumsum(squared, dtype=np.float64)))
    rms = np.sqrt((cumulative[ends] - cumulative[starts]) / np.maximum(ends - starts, 1))
    peak = np.empty(count, dtype=np.float64)
    offsets = np.arange(window_size, dtype=np.int64)[None, :]
    for batch_start in range(0, count, 1_024):
        batch_end = min(count, batch_start + 1_024)
        indices = starts[batch_start:batch_end, None] + offsets
        peak[batch_start:batch_end] = np.max(absolute[indices], axis=1)
    crest = np.sqrt(rms * peak)
    high = max(float(np.quantile(crest, 0.995)), 1e-12)
    amplitude = np.clip(crest / high, 0.0, 1.0)
    return amplitude, rms, peak


def frame_peaks_to_columns(values: np.ndarray, count: int) -> np.ndarray:
    output = np.zeros(count, dtype=np.float64)
    frame_times = (np.arange(len(values), dtype=np.float64) * HOP + N_FFT / 2) / SAMPLE_RATE
    indices = np.rint(frame_times * DETAIL_COLUMNS_PER_SECOND).astype(np.int64)
    valid = (indices >= 0) & (indices < count) & (values > 0)
    np.maximum.at(output, indices[valid], values[valid])
    return np.clip(output, 0.0, 1.0)


def spread_column_peaks(source: np.ndarray) -> np.ndarray:
    output = source.copy()
    for offset, weight in ((-1, 0.42), (1, 0.72), (2, 0.34)):
        if offset < 0:
            output[:offset] = np.maximum(output[:offset], source[-offset:] * weight)
        else:
            output[offset:] = np.maximum(output[offset:], source[:-offset] * weight)
    return np.clip(output, 0.0, 1.0)


def spread_frame_peaks(values: np.ndarray, frame_hz: float, count: int) -> np.ndarray:
    del frame_hz  # Kept in the signature to document the source cadence.
    return spread_column_peaks(frame_peaks_to_columns(values, count))


def colour_from_bands(
    bands: np.ndarray, gamma: float, floor: float
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    total = np.maximum(np.sum(bands, axis=0), 1e-12)
    shares = bands / total[None, :]
    references = np.median(shares, axis=1)
    references = np.where(references > 1e-12, references, 1.0)
    deviation = np.power(np.maximum(shares / references[:, None], 0.0), gamma)
    peak = np.maximum(np.max(deviation, axis=0), 1e-12)
    normalised = deviation / peak[None, :]
    rgb = np.rint((floor + (1.0 - floor) * normalised) * 255).clip(0, 255).astype(np.uint8)
    return rgb[0], rgb[1], rgb[2]


def interpolate_frames(values: np.ndarray, count: int) -> np.ndarray:
    frame_times = (np.arange(len(values), dtype=np.float64) * HOP + N_FFT / 2) / SAMPLE_RATE
    column_times = (np.arange(count, dtype=np.float64) + 0.5) / DETAIL_COLUMNS_PER_SECOND
    return np.interp(column_times, frame_times, values, left=values[0], right=values[-1])


def overview_quantile(values: np.ndarray, columns: int, quantile: float) -> np.ndarray:
    output = np.zeros(columns, dtype=np.float64)
    for index in range(columns):
        first = math.floor(index * len(values) / columns)
        last = min(len(values), max(first + 1, math.ceil((index + 1) * len(values) / columns)))
        output[index] = float(np.quantile(values[first:last], quantile))
    return output


def round_float_array(values: np.ndarray, decimals: int = 4) -> list[float]:
    return np.round(np.asarray(values, dtype=np.float64), decimals).tolist()


def extract(path: Path) -> dict:
    samples = decode_mono(path)
    duration = len(samples) / SAMPLE_RATE
    spectra = analyse_spectra(samples)
    amplitude, _rms, _peak = pixel_envelope(samples)
    count = len(amplitude)
    frame_hz = float(spectra["frame_hz"])

    drum_core = frame_peaks_to_columns(np.asarray(spectra["drum"]), count)
    kick_core = frame_peaks_to_columns(np.asarray(spectra["kick"]), count)
    snare_core = frame_peaks_to_columns(np.asarray(spectra["snare"]), count)
    hat_core = frame_peaks_to_columns(np.asarray(spectra["hat"]), count)
    drum = spread_column_peaks(drum_core)
    kick = spread_column_peaks(kick_core)
    snare = spread_column_peaks(snare_core)
    hat = spread_column_peaks(hat_core)
    vocal_like = interpolate_frames(np.asarray(spectra["vocal_like"]), count)
    semantic_low = frame_peaks_to_columns(np.asarray(spectra["semantic_low"]), count)
    semantic_high = frame_peaks_to_columns(np.asarray(spectra["semantic_high"]), count)

    detail_span = max(3, round(frame_hz * 0.030)) | 1
    detail_bands = np.vstack(
        [
            interpolate_frames(moving_average(np.asarray(spectra[name]), detail_span), count)
            for name in ("energy_low", "energy_mid", "energy_high")
        ]
    )
    detail_r, detail_g, detail_b = colour_from_bands(
        detail_bands, COLOR_GAMMA_DETAIL, COLOR_FLOOR_DETAIL
    )

    overview_raw = overview_quantile(amplitude, OVERVIEW_COLUMNS, 0.72)
    overview_low = float(np.quantile(overview_raw, 0.05))
    overview_high = float(np.quantile(overview_raw, 0.99))
    overview_amp = np.power(
        np.clip(
            (overview_raw - overview_low) / max(overview_high - overview_low, 1e-12),
            0.0,
            1.0,
        ),
        1.2,
    )
    frame_band_stack = np.vstack(
        [np.asarray(spectra[name], dtype=np.float64) for name in ("energy_low", "energy_mid", "energy_high")]
    )
    overview_bands = np.vstack(
        [overview_quantile(row, OVERVIEW_COLUMNS, 0.50) for row in frame_band_stack]
    )
    overview_span = max(3, (OVERVIEW_COLUMNS // 128)) | 1
    overview_bands = np.vstack([moving_average(row, overview_span) for row in overview_bands])
    overview_r, overview_g, overview_b = colour_from_bands(
        overview_bands, COLOR_GAMMA_OVERVIEW, COLOR_FLOOR_OVERVIEW
    )
    overview_semantic_span = max(3, round(OVERVIEW_COLUMNS / duration * 1.2)) | 1
    overview_vocal = moving_average(
        overview_quantile(vocal_like, OVERVIEW_COLUMNS, 0.65), overview_semantic_span
    )
    overview_drum_core = overview_quantile(drum_core, OVERVIEW_COLUMNS, 1.0)
    overview_kick_core = overview_quantile(kick_core, OVERVIEW_COLUMNS, 1.0)
    overview_snare_core = overview_quantile(snare_core, OVERVIEW_COLUMNS, 1.0)
    overview_hat_core = overview_quantile(hat_core, OVERVIEW_COLUMNS, 1.0)
    overview_semantic_low = overview_quantile(semantic_low, OVERVIEW_COLUMNS, 1.0)
    overview_semantic_high = overview_quantile(semantic_high, OVERVIEW_COLUMNS, 1.0)

    active = drum[drum > 0]
    event_count = int(np.count_nonzero(np.asarray(spectra["drum"]) > 0))
    return {
        "schema": "kdj-waveform-pure-dsp-audit-v2",
        "source_path": str(path),
        "title": path.stem,
        "duration": round(duration, 6),
        "sample_rate": SAMPLE_RATE,
        "feature_hz": DETAIL_COLUMNS_PER_SECOND,
        "method": {
            "separation_model": None,
            "stft": {"n_fft": N_FFT, "hop": HOP, "lag": LAG},
            "onset": "positive log spectral flux + frequency max filter + adaptive local peak gate",
            "vocal_likelihood": "180-5000 Hz share + spectral tonality + 75-420 Hz autocorrelation periodicity; not source separation",
            "semantic_colour_axes": "R=low-frequency onset evidence, G=mid-band harmonic periodicity, B=high-frequency onset evidence",
            "bands_hz": {
                "kick_flux": [35, 190],
                "snare_body": [150, 1_400],
                "snare_attack": [1_800, 8_000],
                "hat": [6_000, 16_000],
            },
            "height": "400 columns/s, overlapping 10 ms linear sqrt(RMS*peak); sparse onset consumes remaining headroom",
            "renderer_contract": "one independent vertical pixel column per time bucket; no horizontal height interpolation",
        },
        "summary": {
            "event_count": event_count,
            "events_per_second": round(event_count / max(duration, 1e-9), 3),
            "active_peak_median": round(float(np.median(active)) if active.size else 0.0, 4),
        },
        "detail": {
            "amp": round_float_array(amplitude),
            "drum": round_float_array(drum),
            "drum_core": round_float_array(drum_core),
            "kick": round_float_array(kick),
            "kick_core": round_float_array(kick_core),
            "snare": round_float_array(snare),
            "snare_core": round_float_array(snare_core),
            "hat": round_float_array(hat),
            "hat_core": round_float_array(hat_core),
            "vocal_like": round_float_array(vocal_like),
            "semantic_low": round_float_array(semantic_low),
            "semantic_mid": round_float_array(vocal_like),
            "semantic_high": round_float_array(semantic_high),
            "r": detail_r.tolist(),
            "g": detail_g.tolist(),
            "b": detail_b.tolist(),
        },
        "overview": {
            "amp": round_float_array(overview_amp),
            "r": overview_r.tolist(),
            "g": overview_g.tolist(),
            "b": overview_b.tolist(),
            "drum_core": round_float_array(overview_drum_core),
            "kick_core": round_float_array(overview_kick_core),
            "snare_core": round_float_array(overview_snare_core),
            "hat_core": round_float_array(overview_hat_core),
            "vocal_like": round_float_array(overview_vocal),
            "semantic_low": round_float_array(overview_semantic_low),
            "semantic_mid": round_float_array(overview_vocal),
            "semantic_high": round_float_array(overview_semantic_high),
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    payload = extract(args.input)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
    print(
        json.dumps(
            {
                "source": payload["source_path"],
                "duration": payload["duration"],
                "feature_hz": payload["feature_hz"],
                **payload["summary"],
                "output": str(args.output),
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
