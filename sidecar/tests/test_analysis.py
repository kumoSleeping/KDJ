"""分析引擎的合成信号测试：不依赖任何外部音频文件，也不碰 ffmpeg。

所有断言都走 numpy 层的公开函数 `(samples, sr)`，文件层（engine.analyze_file）只测
不需要解码的纯逻辑部分（分析窗口计算 / 表格自洽性）。
"""

from __future__ import annotations

import sys
import types
from pathlib import Path

import numpy as np
import pytest

SIDECAR = Path(__file__).resolve().parents[1]
if str(SIDECAR) not in sys.path:
    sys.path.insert(0, str(SIDECAR))


def _load_analysis():
    """导入分析子包。

    kumodeck 的包初始化将来可能引入 fastapi/uvicorn 等运行期依赖，而分析层只依赖
    numpy。这里先正常导入，失败就用一个只带 __path__ 的壳模块顶掉包初始化，
    保证纯 numpy 环境（未 pip install 整个 sidecar）也能跑这份测试。
    """
    try:
        from kumodeck.analysis import engine, key, loudness, tempo
    except Exception:
        shell = types.ModuleType("kumodeck")
        shell.__path__ = [str(SIDECAR / "kumodeck")]
        sys.modules["kumodeck"] = shell
        for name in list(sys.modules):
            if name.startswith("kumodeck."):
                del sys.modules[name]
        from kumodeck.analysis import engine, key, loudness, tempo
    return engine, key, loudness, tempo


engine, key_mod, loudness, tempo = _load_analysis()

SR = 22050


# ---------------------------------------------------------------- 合成信号


def click_track(bpm: float, seconds: float = 30.0, sr: int = SR, seed: int = 7) -> np.ndarray:
    """点击轨：每拍一个 15 ms 指数衰减白噪声爆发 + 一点底噪。"""
    rng = np.random.default_rng(seed)
    total = int(seconds * sr)
    y = rng.normal(0.0, 0.003, total).astype(np.float32)  # 底噪，避免纯静音的退化情况

    burst_len = int(0.015 * sr)
    decay = np.exp(-np.linspace(0.0, 7.0, burst_len)).astype(np.float32)
    period = 60.0 / bpm
    beats = int((seconds - 0.05) / period) + 1
    for k in range(beats):
        start = int(round(k * period * sr))  # 用 k*period 而不是累加，避免浮点漂移
        stop = start + burst_len
        if stop >= total:
            break
        burst = rng.normal(0.0, 1.0, burst_len).astype(np.float32) * decay
        y[start:stop] += burst * 0.5
    return y


def midi_to_hz(midi: float) -> float:
    return 440.0 * 2.0 ** ((midi - 69.0) / 12.0)


def chord_loop(
    chords: list[list[int]],
    seconds_per_chord: float = 1.0,
    repeats: int = 4,
    sr: int = SR,
    harmonics: int = 4,
) -> np.ndarray:
    """和弦循环：每个音含 `harmonics` 次谐波，幅度按 1/k 衰减，带缓入缓出包络。"""
    rng = np.random.default_rng(11)
    n = int(seconds_per_chord * sr)
    t = np.arange(n, dtype=np.float64) / sr
    # 头尾 30 ms 淡入淡出，制造音符起音，也避免拼接处的爆音
    fade = int(0.03 * sr)
    envelope = np.ones(n)
    envelope[:fade] = np.linspace(0.0, 1.0, fade)
    envelope[-fade:] = np.linspace(1.0, 0.0, fade)

    blocks = []
    for _ in range(repeats):
        for notes in chords:
            block = np.zeros(n, dtype=np.float64)
            for midi in notes:
                base = midi_to_hz(midi)
                for k in range(1, harmonics + 1):
                    block += np.sin(2.0 * np.pi * base * k * t) / k
            block *= envelope
            blocks.append(block)
    y = np.concatenate(blocks)
    y = y / np.max(np.abs(y)) * 0.8
    y += rng.normal(0.0, 0.001, y.size)
    return y.astype(np.float32)


# ---------------------------------------------------------------- BPM


@pytest.mark.parametrize("expected", [128.0, 90.0, 174.0])
def test_bpm_on_click_track(expected: float) -> None:
    samples = click_track(expected, seconds=30.0)
    result = tempo.analyze_tempo(samples, SR)
    assert abs(result.bpm - expected) < 1.5, f"{expected} BPM 被判成 {result.bpm}"
    assert result.confidence > 0.5
    assert len(result.beat_times) > 20
    assert 0.0 <= result.first_beat < result.beat_interval * 2


def test_beat_grid_is_monotonic_and_evenly_spaced() -> None:
    samples = click_track(124.0, seconds=20.0)
    result = tempo.analyze_tempo(samples, SR)
    times = np.asarray(result.beat_times)
    assert times.size > 15
    intervals = np.diff(times)
    assert np.all(intervals > 0), "拍点必须严格递增"
    expected_interval = 60.0 / 124.0
    assert abs(float(np.median(intervals)) - expected_interval) < 0.03


def test_comb_score_rejects_half_and_double_tempo() -> None:
    """梳状滤波必须给真周期最高分，倍/半速的对比度应当明显更低。"""
    samples = click_track(128.0, seconds=20.0)
    env, fps = tempo.onset_envelope(samples, SR)
    true_period = 60.0 * fps / 128.0
    score_true = tempo.comb_score(env, true_period)
    score_half = tempo.comb_score(env, true_period * 2.0)  # 64 BPM
    score_double = tempo.comb_score(env, true_period / 2.0)  # 256 BPM
    assert score_true > score_half * 1.5
    assert score_true > score_double * 1.5


def test_silence_does_not_crash_tempo() -> None:
    result = tempo.analyze_tempo(np.zeros(SR * 3, dtype=np.float32), SR)
    assert result.bpm == 0.0
    assert result.beat_times == []


# ---------------------------------------------------------------- 调性


def test_a_minor_chord_loop() -> None:
    # A3 - C4 - E4
    samples = chord_loop([[57, 60, 64]], seconds_per_chord=1.0, repeats=8)
    result = key_mod.analyze_key(samples, SR)
    assert result.camelot in {"8A", "8B"}, f"得到 {result.key} / {result.camelot}"
    assert "minor" in result.key, f"A 小调三和弦被判成 {result.key}"
    assert result.camelot == "8A"
    assert result.open_key == "1m"
    assert len(result.chroma) == 12


def test_c_major_chord_loop() -> None:
    # C4 - E4 - G4，再走 G / F 和弦（契约 3.3 的验证要求）
    samples = chord_loop([[60, 64, 67], [55, 59, 62], [53, 57, 60]], seconds_per_chord=1.0, repeats=4)
    result = key_mod.analyze_key(samples, SR)
    assert result.camelot in {"8A", "8B"}, f"得到 {result.key} / {result.camelot}"


def test_chroma_peaks_match_played_pitch_classes() -> None:
    samples = chord_loop([[60, 64, 67]], seconds_per_chord=1.0, repeats=6)
    chroma = key_mod.compute_chroma(samples, SR)
    top3 = set(np.argsort(chroma)[-3:].tolist())
    assert top3 == {0, 4, 7}, f"chroma 峰值应落在 C/E/G，实际 {top3}"


def test_camelot_table_matches_circle_of_fifths() -> None:
    """把契约表格和五度圈公式对一遍，防止手抄错行。

    大调：C=8B 起，每上一个纯五度号数 +1 → num = ((7 + pc*7) mod 12) + 1
    小调：与其关系大调（主音 +3 个半音）同号，字母换成 A
    """
    assert len(key_mod.CAMELOT) == 24
    assert len(set(key_mod.CAMELOT.values())) == 24
    for pc in range(12):
        major_num = ((7 + pc * 7) % 12) + 1
        assert key_mod.CAMELOT[(pc, False)] == f"{major_num}B"
        minor_num = ((7 + ((pc + 3) % 12) * 7) % 12) + 1
        assert key_mod.CAMELOT[(pc, True)] == f"{minor_num}A"


def test_open_key_conversion() -> None:
    # OpenKey 1d = C 大调 = Camelot 8B；1m = A 小调 = 8A
    assert key_mod.camelot_to_open_key("8B") == "1d"
    assert key_mod.camelot_to_open_key("8A") == "1m"
    assert key_mod.camelot_to_open_key("1A") == "6m"
    assert key_mod.camelot_to_open_key("6B") == "11d"
    assert key_mod.camelot_to_open_key("12B") == "5d"
    numbers = {key_mod.camelot_to_open_key(f"{n}A") for n in range(1, 13)}
    assert numbers == {f"{n}m" for n in range(1, 13)}


def test_silence_key_is_empty() -> None:
    result = key_mod.analyze_key(np.zeros(SR * 2, dtype=np.float32), SR)
    assert result.camelot == ""
    assert result.confidence == 0.0


# ---------------------------------------------------------------- 响度


def test_rms_of_minus20dbfs_sine() -> None:
    t = np.arange(SR * 5, dtype=np.float64) / SR
    amplitude = 10.0 ** (-20.0 / 20.0)  # -20 dBFS 峰值
    samples = (amplitude * np.sin(2.0 * np.pi * 440.0 * t)).astype(np.float32)
    result = loudness.analyze_loudness(samples, SR)
    assert -24.0 <= result.rms_db <= -16.0
    assert abs(result.peak_db - (-20.0)) < 0.2
    assert abs(result.crest_db - (result.peak_db - result.rms_db)) < 1e-6
    assert 1 <= result.energy <= 10


def test_energy_scale_anchors() -> None:
    assert loudness.energy_from_rms_db(-30.0) == 1
    assert loudness.energy_from_rms_db(-6.0) == 10
    assert loudness.energy_from_rms_db(-60.0) == 1  # 夹取
    assert loudness.energy_from_rms_db(0.0) == 10
    assert loudness.energy_from_rms_db(-22.0) == 4
    assert loudness.energy_from_rms_db(-18.0) == 6  # 正中点 5.5，四舍五入到 6


# ---------------------------------------------------------------- 引擎装配


def test_analyze_samples_fills_every_section() -> None:
    click = click_track(128.0, seconds=20.0)
    chord = chord_loop([[57, 60, 64]], seconds_per_chord=1.0, repeats=20)
    mixed = click[: chord.size] + chord[: click.size] * 0.6
    result = engine.analyze_samples(mixed, SR, offset=12.0)

    assert result.errors == []
    assert result.bpm is not None and abs(result.bpm - 128.0) < 2.0
    assert result.camelot != ""
    assert result.rms_db is not None and result.energy is not None
    assert result.beat_times and result.beat_times[0] >= 12.0  # 拍点已换算成全曲绝对时间
    assert result.first_beat is not None and 0.0 <= result.first_beat < 60.0 / result.bpm + 1e-6


def test_analysis_window_rules() -> None:
    # 短曲整段分析
    assert engine.analysis_window(45.0, 240.0) == (0.0, None)
    # 长曲从 15% 处起，最多 duration_limit 秒
    offset, length = engine.analysis_window(600.0, 240.0)
    assert abs(offset - 90.0) < 1e-6
    assert abs(length - 240.0) < 1e-6
    # 剩余不足 duration_limit 时按剩余取
    offset, length = engine.analysis_window(200.0, 240.0)
    assert abs(offset - 30.0) < 1e-6
    assert abs(length - 170.0) < 1e-6
    # 时长未知
    assert engine.analysis_window(None, 240.0) == (0.0, 240.0)
