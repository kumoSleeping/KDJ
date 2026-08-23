#!/usr/bin/env python3
"""Standalone official DTTNet checkpoint benchmark; never used by the KDJ runtime."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import platform
import statistics
import sys
import threading
import time
import types
import typing

import numpy as np
import psutil
import soundfile as sf
import torch
import yaml


def install_legacy_import_shims() -> None:
    original_stft, original_istft = torch.stft, torch.istft

    def stft(value, *args, **kwargs):
        kwargs["return_complex"] = True
        return torch.view_as_real(original_stft(value, *args, **kwargs))

    def istft(value, *args, **kwargs):
        if not value.is_complex():
            value = torch.view_as_complex(value.contiguous())
        return original_istft(value, *args, **kwargs)

    torch.stft, torch.istft = stft, istft
    lightning = types.ModuleType("pytorch_lightning")

    class LightningModule(torch.nn.Module):
        def log(self, *_args, **_kwargs):
            return None

    lightning.LightningModule = LightningModule
    sys.modules["pytorch_lightning"] = lightning
    lightning_types = types.ModuleType("pytorch_lightning.utilities.types")
    lightning_types.STEP_OUTPUT = typing.Any
    sys.modules["pytorch_lightning.utilities.types"] = lightning_types
    utils_package = types.ModuleType("src.utils")
    utils_package.__path__ = []
    utils = types.ModuleType("src.utils.utils")
    utils.sdr = lambda *_args: 0.0
    utils.simplified_msseval = lambda *_args: 0.0
    sys.modules["src.utils"] = utils_package
    sys.modules["src.utils.utils"] = utils


def synchronize(device: torch.device) -> None:
    if device.type == "mps":
        torch.mps.synchronize()
    elif device.type == "cuda":
        torch.cuda.synchronize(device)


class MemorySampler:
    def __init__(self, device: torch.device):
        self.device = device
        self.process = psutil.Process()
        self.peak_rss = self.process.memory_info().rss
        self.peak_allocated = 0
        self.peak_driver = 0
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self.sample, daemon=True)

    def sample(self):
        while not self.stop.wait(0.005):
            self.peak_rss = max(self.peak_rss, self.process.memory_info().rss)
            if self.device.type == "mps":
                self.peak_allocated = max(self.peak_allocated, torch.mps.current_allocated_memory())
                self.peak_driver = max(self.peak_driver, torch.mps.driver_allocated_memory())

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_args):
        self.stop.set()
        self.thread.join()
        self.peak_rss = max(self.peak_rss, self.process.memory_info().rss)

    def report(self):
        return {
            "rss_bytes": self.peak_rss,
            "device_allocated_bytes": self.peak_allocated,
            "driver_allocated_bytes": self.peak_driver,
        }


def percentile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    position = fraction * (len(ordered) - 1)
    low, high = math.floor(position), math.ceil(position)
    return ordered[low] + (ordered[high] - ordered[low]) * (position - low)


def distribution(values: list[float]) -> dict[str, float]:
    return {
        "mean": statistics.mean(values),
        "p50": percentile(values, 0.50),
        "p95": percentile(values, 0.95),
        "p99": percentile(values, 0.99),
        "max": max(values),
    }


def load_audio(path: Path, samples: int) -> torch.Tensor:
    audio, rate = sf.read(path, dtype="float32", always_2d=True)
    if rate != 44_100 or audio.shape[1] != 2:
        raise ValueError(f"{path} must be 44.1 kHz stereo")
    if len(audio) < samples:
        audio = np.tile(audio, ((samples + len(audio) - 1) // len(audio), 1))
    return torch.from_numpy(audio[:samples].T.copy())


def infer(model, value: torch.Tensor, device: torch.device) -> tuple[torch.Tensor, float]:
    value = value.to(device)
    synchronize(device)
    started = time.perf_counter()
    with torch.inference_mode():
        output = model.istft(model(model.stft(value)))
    synchronize(device)
    return output.detach().cpu(), time.perf_counter() - started


def run(args) -> dict:
    if args.device == "mps" and not torch.backends.mps.is_available():
        raise RuntimeError("MPS is unavailable")
    repository = args.repository.resolve()
    sys.path.insert(0, str(repository))
    install_legacy_import_shims()
    from src.dp_tdf.dp_tdf_net import DPTDFNet

    config_path = repository / "configs/model" / f"{args.stem}.yaml"
    checkpoint_path = args.checkpoint.resolve()
    config = yaml.safe_load(config_path.read_text())
    config.pop("_target_")
    load_started = time.perf_counter()
    model = DPTDFNet(**config)
    checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=False)
    model.load_state_dict(checkpoint["state_dict"], strict=True)
    model.eval()
    model_load_seconds = time.perf_counter() - load_started
    device = torch.device(args.device)
    move_started = time.perf_counter()
    model.to(device)
    synchronize(device)
    model_move_seconds = time.perf_counter() - move_started
    tracks = sorted(args.corpus.glob("*.wav"))[:20]
    if len(tracks) != 20:
        raise ValueError(f"expected 20 WAV files in {args.corpus}, found {len(tracks)}")
    inputs = [load_audio(path, model.chunk_size) for path in tracks]

    with MemorySampler(device) as memory:
        first_output, first_seconds = infer(model, inputs[0].unsqueeze(0), device)
        infer(model, inputs[0].unsqueeze(0), device)
        per_track = []
        for path, value in zip(tracks, inputs):
            output, elapsed = infer(model, value.unsqueeze(0), device)
            per_track.append({
                "track": path.name,
                "seconds": elapsed,
                "rtf": elapsed / (model.chunk_size / 44_100),
                "rms": float(output.square().mean().sqrt()),
                "non_finite": int((~torch.isfinite(output)).sum()),
            })
        dual_times = []
        for index in range(20):
            pair = torch.stack([inputs[index], inputs[(index + 1) % 20]])
            _, elapsed = infer(model, pair, device)
            dual_times.append(elapsed)

        shift = 44_100
        long_input = torch.cat([inputs[0], inputs[0]], dim=-1)
        left_output, _ = infer(model, long_input[:, :model.chunk_size].unsqueeze(0), device)
        right_output, _ = infer(
            model, long_input[:, shift:shift + model.chunk_size].unsqueeze(0), device
        )
        overlap_samples = model.chunk_size - shift
        trim = 44_100
        left_overlap = left_output[..., shift:shift + overlap_samples]
        right_overlap = right_output[..., :overlap_samples]
        if overlap_samples > 2 * trim:
            left_overlap = left_overlap[..., trim:-trim]
            right_overlap = right_overlap[..., trim:-trim]
        error = left_overlap - right_overlap
        context_shift_sdr_db = 10 * math.log10(
            float(left_overlap.square().sum()) / max(float(error.square().sum()), 1e-30)
        )

    single_times = [item["seconds"] for item in per_track]
    audio_seconds = model.chunk_size / 44_100
    return {
        "candidate": f"dttnet-{args.stem}",
        "repository_commit": args.commit,
        "device": args.device,
        "torch": torch.__version__,
        "python": platform.python_version(),
        "checkpoint": str(checkpoint_path),
        "checkpoint_bytes": checkpoint_path.stat().st_size,
        "parameter_count": sum(parameter.numel() for parameter in model.parameters()),
        "model_load_seconds": model_load_seconds,
        "model_move_seconds": model_move_seconds,
        "first_inference_seconds": first_seconds,
        "chunk_samples": model.chunk_size,
        "chunk_seconds": audio_seconds,
        "stft_n_fft": model.n_fft,
        "stft_hop": model.hop_length,
        "bidirectional_lstm": bool(config["bandsequence"]["bidirectional"]),
        "official_overlap_add_rate": 0.5,
        "single_deck_seconds": distribution(single_times),
        "single_deck_rtf_mean": statistics.mean(single_times) / audio_seconds,
        "dual_deck_batch_seconds": distribution(dual_times),
        "dual_deck_aggregate_rtf_mean": statistics.mean(dual_times) / (2 * audio_seconds),
        "one_second_context_shift_overlap_sdr_db": context_shift_sdr_db,
        "output_shape": list(first_output.shape),
        "memory": memory.report(),
        "tracks": per_track,
    }


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repository", type=Path, required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--stem", choices=["bass", "drums", "other", "vocals"], required=True)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--corpus", type=Path, required=True)
    parser.add_argument("--device", choices=["cpu", "mps", "cuda"], required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


if __name__ == "__main__":
    arguments = parse_args()
    result = run(arguments)
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    arguments.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))
