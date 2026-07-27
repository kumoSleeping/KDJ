import { useCallback, useEffect, useRef, useState } from "react";
import { Blend, Clapperboard, Disc3, Download, LoaderCircle, Minus, Play, Plus, Scissors } from "lucide-react";
import { api } from "../../lib/api";
import {
  AUDIO_FOCUS_EVENT,
  announceAudioFocus,
  type AudioFocusDetail,
} from "../../lib/audioFocus";
import { deckGain, previewGain, useCrossfade } from "../../lib/crossfade";
import { djEngine } from "../../lib/djMix";
import { formatDuration } from "../../lib/format";
import {
  MEDIA_SYNC_EVENT,
  broadcastMediaSync,
  type MediaSyncDetail,
} from "../../lib/mediaSync";
import { useAppStore } from "../../stores/appStore";
import { useDownloadStore } from "../../stores/downloadStore";
import { selectSelectedTrack, useLibraryStore } from "../../stores/libraryStore";
import { Button, InlineNotice } from "../common";

/** 「预览这个视频」：结果行发出来，Workspace 接住后把预览面板放进右栏。 */
export const VIDEO_PREVIEW_EVENT = "kd:video-preview";

export interface VideoPreviewRequest {
  bvid: string;
  title: string;
  author: string;
  /** 分 P 下标，从 0 起。 */
  page: number;
}

export function requestVideoPreview(req: VideoPreviewRequest): void {
  window.dispatchEvent(
    new CustomEvent<VideoPreviewRequest>(VIDEO_PREVIEW_EVENT, { detail: req }),
  );
}

/**
 * 实时波形的桶数。右栏 240–600px 宽，480 桶约合一像素一桶；
 * 桶按 currentTime/duration 定位，快进回退都落在自己的位置上。
 */
const BUCKETS = 480;
/** 波形条高度：和底部播放条的 38px 一个量级，矮一点表明它是"副"进度条。 */
const WAVE_HEIGHT = 34;
const calibrationCache = new Map<string, { offsetMs: number; score: number }>();

/**
 * 右栏的视频预览面板。
 *
 * 曲库的曲子有分析好的整轨波形可画，预览流没有——只能一边放一边听：
 * 声音过 WebAudio 的 AnalyserNode 采振幅，按播放位置落进桶里，
 * 听过哪里哪里就有波形。样式对齐底部播放条那条波形（已播压暗、白线播放头、
 * 点击跳转），这块"随着声音长出来"的波形就是预览的进度条。
 */
export function VideoPreview({ req }: { req: VideoPreviewRequest }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const suppressSyncEventRef = useRef(false);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sampleRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const bucketsRef = useRef<Float32Array>(new Float32Array(BUCKETS));
  /** 自动校准的请求代数：预览卸载/换曲后，旧 Promise 不得重新打开协同。 */
  const calibrationSeqRef = useRef(0);
  /** 负 Offset 下延迟起播的定时器：留白期间视频停在 0 等着。 */
  const delayTimerRef = useRef<number | null>(null);
  const clearDelay = useCallback(() => {
    if (delayTimerRef.current !== null) {
      window.clearTimeout(delayTimerRef.current);
      delayTimerRef.current = null;
    }
  }, []);

  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState("");

  const coplay = useCrossfade((state) => state.coplay);
  const fadeX = useCrossfade((state) => state.x);
  const setCoplay = useCrossfade((state) => state.setCoplay);
  const setX = useCrossfade((state) => state.setX);

  /**
   * Offset（毫秒）：成品相对原片的起点偏移。正=掐头，负=开头补留白。
   * 每按一下 ± 都顺手把视频 seek 同样的量——协同播放时人对着唱盘的拍子
   * 一下一下按到合上为止，按出来的累计值就是该掐/该补的长度。
   */
  const [offsetMs, setOffsetMs] = useState(0);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const [syncError, setSyncError] = useState("");
  const [calibrating, setCalibrating] = useState(false);
  const selectedTrack = useLibraryStore(selectSelectedTrack);
  const settings = useAppStore((state) => state.settings);
  const mergeTasks = useDownloadStore((state) => state.mergeTasks);

  /**
   * AnalyserNode 只建一次：createMediaElementSource 对同一个 <video>
   * 只允许调用一回，重复调直接抛异常。建在首次播放而不是挂载时——
   * AudioContext 要用户手势才肯出声，「预览」按钮那一下就是手势。
   */
  const ensureAnalyser = useCallback(() => {
    const video = videoRef.current;
    if (!video || audioCtxRef.current) {
      void audioCtxRef.current?.resume();
      return;
    }
    try {
      const ctx = new AudioContext();
      const source = ctx.createMediaElementSource(video);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      analyser.connect(ctx.destination);
      audioCtxRef.current = ctx;
      analyserRef.current = analyser;
      sampleRef.current = new Uint8Array(analyser.fftSize);
      void ctx.resume();
    } catch {
      // 建不起来只是没有波形可看，声音走 <video> 自己的通路照常出
    }
  }, []);

  useEffect(
    () => () => {
      calibrationSeqRef.current += 1;
      clearDelay();
      void audioCtxRef.current?.close();
      // 预览没了协同也就没了：不收这一下，唱盘会永远停在推子分给它的音量上
      useCrossfade.getState().setCoplay(false);
      // store 的 React effect 要到下一帧才恢复 deck；这里同步兜底，避免推子在
      // 最右时退出后立刻点播放，进度在走但 element.volume 仍近似 0。
      djEngine.setVolume(1);
    },
    [clearDelay],
  );

  // 别人开声（曲库开始预听）就自己停，见 audioFocus.ts 的约定。
  // 唯一的例外是协同播放：和唱盘一起响正是它的本意。
  useEffect(() => {
    const onFocus = (event: Event) => {
      const owner = (event as CustomEvent<AudioFocusDetail>).detail.owner;
      if (owner === "preview") return;
      if (owner === "player" && useCrossfade.getState().coplay) return;
      videoRef.current?.pause();
    };
    window.addEventListener(AUDIO_FOCUS_EVENT, onFocus);
    return () => window.removeEventListener(AUDIO_FOCUS_EVENT, onFocus);
  }, []);

  // 协同播放时播放器是主时钟。视频只在累计漂移超过 120ms 时纠偏，
  // 这样不会因为每次 timeupdate 都 seek 而让画面出现细小跳动。
  useEffect(() => {
    const onMediaSync = (event: Event) => {
      const detail = (event as CustomEvent<MediaSyncDetail>).detail;
      if (detail.owner !== "player" || !useCrossfade.getState().coplay) return;
      const video = videoRef.current;
      if (!video) return;
      const target = (detail.position ?? 0) + offsetMs / 1000;
      if (detail.action === "play") {
        clearDelay();
        suppressSyncEventRef.current = true;
        if (target < 0) {
          video.pause();
          video.currentTime = 0;
          suppressSyncEventRef.current = false;
          delayTimerRef.current = window.setTimeout(() => {
            delayTimerRef.current = null;
            suppressSyncEventRef.current = true;
            void video.play().catch(() => undefined).finally(() => {
              suppressSyncEventRef.current = false;
            });
          }, -target * 1000);
        } else {
          if (Math.abs(video.currentTime - target) > 0.12) video.currentTime = target;
          void video.play().catch(() => undefined).finally(() => {
            suppressSyncEventRef.current = false;
          });
        }
      } else if (detail.action === "pause") {
        clearDelay();
        suppressSyncEventRef.current = true;
        video.pause();
        suppressSyncEventRef.current = false;
      } else if (detail.action === "seek" || detail.action === "position") {
        if (Number.isFinite(target) && Math.abs(video.currentTime - target) > 0.12) {
          suppressSyncEventRef.current = true;
          video.currentTime = Math.max(0, target);
          suppressSyncEventRef.current = false;
        }
      }
    };
    window.addEventListener(MEDIA_SYNC_EVENT, onMediaSync);
    return () => window.removeEventListener(MEDIA_SYNC_EVENT, onMediaSync);
  }, [offsetMs, clearDelay]);

  // 推子分给预览这一侧的音量。volume 挂在 <video> 上，AnalyserNode 采到的
  // 是衰减后的信号——波形跟着推子一起矮下去，正好和耳朵听到的一致。
  useEffect(() => {
    const video = videoRef.current;
    if (video) video.volume = previewGain(coplay, fadeX);
  }, [coplay, fadeX]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (!canvas || !host) return;
    const cssWidth = host.clientWidth;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(cssWidth * dpr));
    canvas.height = Math.round(WAVE_HEIGHT * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, WAVE_HEIGHT);

    const mid = WAVE_HEIGHT / 2;
    // 颜色从 CSS 拿（.kd-preview-wave 的 color = 主题红），canvas 里不写死色值
    const tone = getComputedStyle(canvas).color;
    // 还没听到的区域留一条基线，别让波形悬在一片空白里
    ctx.globalAlpha = 0.25;
    ctx.fillStyle = tone;
    ctx.fillRect(0, mid - 0.5, cssWidth, 1);
    ctx.globalAlpha = 1;

    const buckets = bucketsRef.current;
    const width = Math.max(1, Math.floor(cssWidth));
    for (let x = 0; x < width; x += 1) {
      // 和 Waveform.tsx 同一套按像素列取区间最大值的画法，缩放不丢瞬态
      const from = Math.floor((x * BUCKETS) / width);
      const to = Math.max(from + 1, Math.floor(((x + 1) * BUCKETS) / width));
      let amp = 0;
      for (let i = from; i < to && i < BUCKETS; i += 1) {
        if (buckets[i] > amp) amp = buckets[i];
      }
      if (amp <= 0) continue;
      const half = Math.max(0.5, amp * (mid - 1));
      ctx.fillRect(x, mid - half, 1, half * 2);
    }
  }, []);

  // 播放中每帧采一次振幅落桶再重画；暂停时只画不采
  useEffect(() => {
    if (!playing) {
      draw();
      return;
    }
    let raf = 0;
    const tick = () => {
      const video = videoRef.current;
      const analyser = analyserRef.current;
      const sample = sampleRef.current;
      if (video && analyser && sample && video.duration > 0) {
        analyser.getByteTimeDomainData(sample);
        let sum = 0;
        for (let i = 0; i < sample.length; i += 1) {
          const v = (sample[i] - 128) / 128;
          sum += v * v;
        }
        // RMS 直接画太瘦（满幅正弦也才 0.71），放大后夹到 1
        const amp = Math.min(1, Math.sqrt(sum / sample.length) * 2.8);
        const index = Math.min(
          BUCKETS - 1,
          Math.floor((video.currentTime / video.duration) * BUCKETS),
        );
        if (amp > bucketsRef.current[index]) bucketsRef.current[index] = amp;
      }
      draw();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, draw]);

  // 右栏可拖宽，canvas 得跟着重画
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver(draw);
    observer.observe(host);
    return () => observer.disconnect();
  }, [draw]);

  const toggle = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play().catch(() => undefined);
    else video.pause();
  }, []);

  /**
   * 拨协同开关。开 = 两边**同时从头来**：engage() 的 epoch 让唱盘倒回 0
   * 起播（见 PlayerBar），这边按 Offset 对位——正 Offset 成品掐头，视频
   * 从 Offset 处起；负 Offset 成品前面留白，视频等够留白再起。这样耳朵
   * 听到的两轨关系就是下载回去的成品和唱盘的真实关系。
   * 关 = 预览让位，唱盘继续响。
   */
  const startCoplay = useCallback((alignedOffsetMs: number) => {
    const video = videoRef.current;
    clearDelay();
    if (!video) return;
    useCrossfade.getState().engage();
    if (alignedOffsetMs < 0) {
      video.pause();
      video.currentTime = 0;
      delayTimerRef.current = window.setTimeout(() => {
        delayTimerRef.current = null;
        void video.play().catch(() => undefined);
      }, -alignedOffsetMs);
    } else {
      video.currentTime = alignedOffsetMs / 1000;
      void video.play().catch(() => undefined);
    }
  }, [clearDelay]);

  const toggleCoplay = useCallback(() => {
    const video = videoRef.current;
    clearDelay();
    if (useCrossfade.getState().coplay) {
      setCoplay(false);
      djEngine.setVolume(1);
      video?.pause();
      return;
    }
    if (!selectedTrack) {
      setSyncError("自动校准需要先在曲库里选中一首本地歌曲");
      return;
    }
    video?.pause();
    const cacheKey = `${selectedTrack.id}:${req.bvid}:${req.page}`;
    const cached = calibrationCache.get(cacheKey);
    if (cached) {
      setOffsetMs(cached.offsetMs);
      setSyncError("");
      startCoplay(cached.offsetMs);
      return;
    }
    setCalibrating(true);
    setSyncError("");
    const requestSeq = ++calibrationSeqRef.current;
    void api
      .videoCalibrate(selectedTrack.id, req.bvid, req.page)
      .then((result) => {
        // 面板已卸载/替换，或校准期间用户换了本地曲目：结果属于旧会话，丢弃。
        if (requestSeq !== calibrationSeqRef.current) return;
        if (selectSelectedTrack(useLibraryStore.getState())?.id !== selectedTrack.id) return;
        calibrationCache.set(cacheKey, { offsetMs: result.offset_ms, score: result.score });
        setOffsetMs(result.offset_ms);
        startCoplay(result.offset_ms);
      })
      .catch((reason: unknown) => {
        if (requestSeq !== calibrationSeqRef.current) return;
        setSyncError(`自动校准失败：${reason instanceof Error ? reason.message : String(reason)}`);
      })
      .finally(() => {
        if (requestSeq === calibrationSeqRef.current) setCalibrating(false);
      });
  }, [clearDelay, req.bvid, req.page, selectedTrack, setCoplay, startCoplay]);

  /** ± 一下：Offset 记账，同时把视频 seek 同样的量，耳朵立刻听到新的对位。 */
  const nudge = useCallback((deltaMs: number) => {
    setOffsetMs((value) => value + deltaMs);
    const video = videoRef.current;
    if (video) video.currentTime = Math.max(0, video.currentTime + deltaMs / 1000);
  }, []);

  const download = useCallback(
    async (withOffset: boolean) => {
      setSending(true);
      setSendError("");
      try {
        const task = await api.videoDownload({
          bvid: req.bvid,
          page_index: req.page,
          max_height: settings?.video_max_height ?? 1080,
          audio_only: false,
          // 恒真，理由同 VideoResultRow：不转码的封装一部分软件打不开
          transcode: true,
          offset_ms: withOffset ? Math.round(offsetMs) : 0,
        });
        // 任务当场出现在底下的队列面板里，就是"已加入队列"最好的回执
        mergeTasks([task]);
      } catch (err) {
        setSendError(`下载失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setSending(false);
      }
    },
    [req.bvid, req.page, settings?.video_max_height, offsetMs, mergeTasks],
  );

  const offsetText = `${offsetMs < 0 ? "" : "+"}${(offsetMs / 1000).toFixed(2)}s`;
  const ratio = duration > 0 ? Math.min(1, Math.max(0, position / duration)) : 0;

  return (
    <div className="kd-preview">
      <div className="kd-toolbar" data-slim="true">
        <strong className="kd-nowrap">视频预览</strong>
        <span
          className="kd-muted kd-truncate"
          style={{ fontSize: "var(--kd-size-xs)" }}
          title={`${req.title} — ${req.author}`}
        >
          {req.title}
        </span>
      </div>

      <div className="kd-preview-frame">
        {/* crossOrigin 是给 WebAudio 的：不带它 AnalyserNode 只能采到静音。
            服务端 CORS 全放开（只监听回环 + token），所以敢写 anonymous。 */}
        <video
          ref={videoRef}
          src={api.videoPreviewUrl(req.bvid, req.page)}
          crossOrigin="anonymous"
          preload="none"
          playsInline
          onClick={toggle}
          onPlay={() => {
            setPlaying(true);
            setError("");
            ensureAnalyser();
            announceAudioFocus("preview");
            if (!suppressSyncEventRef.current) {
              broadcastMediaSync({ owner: "preview", action: "play" });
            }
          }}
          onPause={() => {
            setPlaying(false);
            if (useCrossfade.getState().coplay && !suppressSyncEventRef.current) {
              broadcastMediaSync({ owner: "preview", action: "pause" });
            }
          }}
          onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
          onLoadedMetadata={(event) => {
            const value = event.currentTarget.duration;
            if (Number.isFinite(value) && value > 0) setDuration(value);
          }}
          onError={() => {
            setPlaying(false);
            setError("预览加载失败：可能被风控或视频不可用，稍后再试");
          }}
        />
        {/* 暂停时给一颗居中的播放键：没有原生 controls，不给的话
            自动播放被拦住时这块就是一张点不动的黑图 */}
        {!playing && !error && (
          <button type="button" className="kd-preview-go" aria-label="播放" onClick={toggle}>
            <Play size={20} fill="currentColor" />
          </button>
        )}
        {error && <div className="kd-preview-error">{error}</div>}
      </div>

      <div className="kd-preview-scrub">
        <div
          ref={hostRef}
          className="kd-preview-wave"
          title="点击跳转"
          onClick={(event) => {
            const video = videoRef.current;
            if (!video || duration <= 0) return;
            const rect = event.currentTarget.getBoundingClientRect();
            const at = ((event.clientX - rect.left) / rect.width) * duration;
            video.currentTime = at;
            setPosition(at);
            if (useCrossfade.getState().coplay) {
              broadcastMediaSync({
                owner: "preview",
                action: "seek",
                position: Math.max(0, at - offsetMs / 1000),
              });
            }
          }}
        >
          <canvas ref={canvasRef} style={{ display: "block", width: "100%", height: WAVE_HEIGHT }} />
          {/* 已播压暗 + 白线播放头：和底部播放条同一套视觉语言（见 Waveform.tsx） */}
          {ratio > 0 && (
            <span
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                bottom: 0,
                width: `${ratio * 100}%`,
                background: "var(--kd-wave-dim, rgba(0,0,0,0.55))",
                pointerEvents: "none",
              }}
            />
          )}
          <span
            style={{
              position: "absolute",
              left: `${ratio * 100}%`,
              top: 0,
              bottom: 0,
              width: 1,
              background: "#fff",
              boxShadow: "0 0 3px rgba(0,0,0,0.8)",
              pointerEvents: "none",
            }}
          />
        </div>
        <span className="kd-player-time kd-nowrap">
          {formatDuration(position)} / {formatDuration(duration)}
        </span>
      </div>

      {/* 混音台：协同开关 + 交叉推子。语言学播放条的走带区——裸图标、
          靠间距分组，一行里不出现第二块描边方块。 */}
      <div className="kd-xfade">
        <button
          type="button"
          className="kd-player-step kd-xfade-toggle"
          data-on={coplay ? "true" : undefined}
          aria-pressed={coplay}
          aria-label="协同播放"
          disabled={calibrating}
          title={
            coplay
              ? "协同播放中：预览和唱盘一起响，音量归推子管。点一下回到互斥出声"
              : "协同播放：两边同时从头开播（时间线对齐，预览按 Offset 对位），用推子在两边之间混"
          }
          onClick={toggleCoplay}
        >
          {calibrating ? <LoaderCircle size={14} className="kd-spin" /> : <Blend size={14} />}
        </button>
        {/* 两端的脸就是两路声源：唱盘（左）和这块预览（右）。
            透明度跟着等功率增益走，推到哪边哪边的脸亮。 */}
        <Disc3
          size={13}
          aria-hidden="true"
          className="kd-xfade-end"
          style={{ opacity: coplay ? 0.3 + 0.7 * deckGain(coplay, fadeX) : undefined }}
        />
        <div className="kd-xfade-slot">
          <input
            type="range"
            className="kd-xfader"
            min={0}
            max={1000}
            value={Math.round(fadeX * 1000)}
            disabled={!coplay}
            aria-label="交叉推子：左是唱盘，右是预览"
            title="左=唱盘，右=预览，中间=混合（等功率曲线）。双击回中"
            onChange={(event) => setX(Number(event.target.value) / 1000)}
            onDoubleClick={() => setX(0.5)}
          />
        </div>
        <Clapperboard
          size={13}
          aria-hidden="true"
          className="kd-xfade-end"
          style={{ opacity: coplay ? 0.3 + 0.7 * previewGain(coplay, fadeX) : undefined }}
        />
      </div>
      <InlineNotice text={syncError} />

      {/* Offset 校准 + 两条下载路。± 按走带键的裸图标语言；
          数值是唯一的"表"，等宽数字，点一下归零。 */}
      <div className="kd-preview-actions">
        <div className="kd-offset" title="成品起点偏移：正=掐掉开头，负=开头补黑场/静音">
          <button
            type="button"
            className="kd-player-step"
            aria-label="Offset 减 0.1 秒"
            title="−0.1s（Shift −1s）：视频回退一点；负到头就是在开头补留白"
            onClick={(event) => nudge(event.shiftKey ? -1000 : -100)}
          >
            <Minus size={13} />
          </button>
          <button
            type="button"
            className="kd-offset-value"
            data-live={offsetMs !== 0 ? "true" : undefined}
            title="当前 Offset，点一下归零"
            onClick={() => nudge(-offsetMs)}
          >
            {offsetText}
          </button>
          <button
            type="button"
            className="kd-player-step"
            aria-label="Offset 加 0.1 秒"
            title="+0.1s（Shift +1s）：视频快进一点，下载时掐掉的开头就多一点"
            onClick={(event) => nudge(event.shiftKey ? 1000 : 100)}
          >
            <Plus size={13} />
          </button>
        </div>
        <span className="kd-toolbar-gap" />
        <Button
          size="sm"
          disabled={sending || offsetMs === 0}
          title={
            offsetMs === 0
              ? "先用 +/− 校出一个 Offset"
              : offsetMs > 0
                ? `下载并掐掉开头 ${(offsetMs / 1000).toFixed(2)} 秒`
                : `下载并在开头补 ${(-offsetMs / 1000).toFixed(2)} 秒黑场/静音`
          }
          onClick={() => void download(true)}
        >
          <Scissors size={12} />
          按 Offset 下载
        </Button>
        <Button
          size="sm"
          disabled={sending}
          title="按原片下载（画质/格式随全局设置）"
          onClick={() => void download(false)}
        >
          <Download size={12} />
          直接下载
        </Button>
      </div>
      <InlineNotice text={sendError} />
    </div>
  );
}
