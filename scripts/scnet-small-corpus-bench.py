#!/usr/bin/env python3
"""Twenty-track single/dual-Deck SCNet Small benchmark using the pinned external evaluator."""

from __future__ import annotations

import argparse
import importlib
import json
import math
from pathlib import Path
import statistics
import sys
import time

import torch


def percentile(values, fraction):
    ordered = sorted(values)
    position = fraction * (len(ordered) - 1)
    low, high = math.floor(position), math.ceil(position)
    return ordered[low] + (ordered[high] - ordered[low]) * (position - low)


def distribution(values):
    return {
        "mean": statistics.mean(values),
        "p50": percentile(values, 0.50),
        "p95": percentile(values, 0.95),
        "p99": percentile(values, 0.99),
        "max": max(values),
    }


def main(args):
    sys.path.insert(0, str(args.evaluator.resolve()))
    benchmark = importlib.import_module("benchmark_scnet")
    device = torch.device(args.device)
    if device.type == "mps" and not torch.backends.mps.is_available():
        raise RuntimeError("MPS unavailable")
    model, config, load_seconds = benchmark.build_model("scnet-small-official")
    move_started = time.perf_counter()
    model.to(device)
    benchmark.synchronize(device)
    move_seconds = time.perf_counter() - move_started
    tracks = sorted(args.corpus.glob("*.wav"))[:20]
    if len(tracks) != 20:
        raise ValueError(f"expected 20 WAV files, found {len(tracks)}")
    normalize = bool(config.get("inference", {}).get("normalize", False))
    inputs = [benchmark.load_audio(path, args.seconds, normalize)[0] for path in tracks]
    with benchmark.MemorySampler(device) as memory:
        first_output, first_seconds = benchmark.infer(model, inputs[0], device)
        benchmark.infer(model, inputs[0], device)
        per_track = []
        for path, value in zip(tracks, inputs):
            output, elapsed = benchmark.infer(model, value, device)
            per_track.append({
                "track": path.name,
                "seconds": elapsed,
                "rtf": elapsed / args.seconds,
                "rms_by_stem": [float(stem.square().mean().sqrt()) for stem in output[0]],
                "non_finite": int((~torch.isfinite(output)).sum()),
            })
        dual_times = []
        for index in range(20):
            pair = torch.cat([inputs[index], inputs[(index + 1) % 20]], dim=0)
            _, elapsed = benchmark.infer(model, pair, device)
            dual_times.append(elapsed)
        shift = 44_100
        long_input = torch.cat([inputs[0], inputs[0]], dim=-1)
        left_output, _ = benchmark.infer(model, long_input[..., :inputs[0].shape[-1]], device)
        right_output, _ = benchmark.infer(
            model, long_input[..., shift:shift + inputs[0].shape[-1]], device
        )
        output_shift = round(shift * left_output.shape[-1] / inputs[0].shape[-1])
        overlap_samples = min(left_output.shape[-1] - output_shift, right_output.shape[-1])
        trim = min(44_100, max(0, overlap_samples // 4))
        left_overlap = left_output[..., output_shift:output_shift + overlap_samples]
        right_overlap = right_output[..., :overlap_samples]
        if overlap_samples > 2 * trim:
            left_overlap = left_overlap[..., trim:-trim]
            right_overlap = right_overlap[..., trim:-trim]
        error = left_overlap - right_overlap
        context_shift_sdr_db = 10 * math.log10(
            float(left_overlap.square().sum()) / max(float(error.square().sum()), 1e-30)
        )
    single = [item["seconds"] for item in per_track]
    return {
        "candidate": "scnet-small-official",
        "device": args.device,
        "checkpoint_sha256": "1bc0d1abb20bfdf966dcd07637bafd03e4bc13653d09ef18bc9b3e342eafe2aa",
        "parameter_count": sum(parameter.numel() for parameter in model.parameters()),
        "model_load_seconds": load_seconds,
        "model_move_seconds": move_seconds,
        "first_inference_seconds": first_seconds,
        "chunk_seconds": args.seconds,
        "single_deck_seconds": distribution(single),
        "single_deck_rtf_mean": statistics.mean(single) / args.seconds,
        "dual_deck_batch_seconds": distribution(dual_times),
        "dual_deck_aggregate_rtf_mean": statistics.mean(dual_times) / (2 * args.seconds),
        "one_second_context_shift_overlap_sdr_db": context_shift_sdr_db,
        "output_shape": list(first_output.shape),
        "memory": memory.json(),
        "tracks": per_track,
    }


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--evaluator", type=Path, required=True)
    parser.add_argument("--corpus", type=Path, required=True)
    parser.add_argument("--device", choices=["cpu", "mps", "cuda"], required=True)
    parser.add_argument("--seconds", type=float, default=5.92)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


if __name__ == "__main__":
    arguments = parse_args()
    result = main(arguments)
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    arguments.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))
