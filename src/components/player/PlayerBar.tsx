import { useCallback, useEffect, useRef, useState } from "react";
import { Disc3, Play, Square } from "lucide-react";
import { api } from "../../lib/api";
import { analyzePlaying } from "../../lib/autoAnalyze";
import { markPlayed, pickNext } from "../../lib/autoplay";
import { formatDuration } from "../../lib/format";
import type { Track } from "../../types";
import { selectSelectedTrack, useLibraryStore } from "../../stores/libraryStore";
import { InlineNotice } from "../common";
import { POSITION_EVENT, type PositionDetail } from "../library/TrackDetail";
import { PLAY_EVENT, playTrack } from "../library/TrackTable";
import { SEEK_EVENT, Waveform, type SeekDetail } from "../library/Waveform";

/** 广播播放位置的节流间隔：节拍网格的播放头不需要每帧更新。 */
const POSITION_BROADCAST_MS = 200;

export function PlayerBar() {
  const selected = useLibraryStore(selectSelectedTrack);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const lastBroadcast = useRef(0);

  const [track, setTrack] = useState<Track | null>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  /**
   * 放不出来的原因写在曲名底下。播放条是"现在在放什么"的唯一显示，
   * 按下播放却没有声音时，人的眼睛就在这里——错误理应也在这里。
   */
  const [notice, setNotice] = useState("");

  // 曲库表格双击 → 这里换曲并播放。用全局事件而不是共享 store，
  // 是为了让"能触发播放"的组件不必都知道播放器的存在。
  useEffect(() => {
    const onPlay = (event: Event) => {
      const next = (event as CustomEvent<Track>).detail;
      setTrack(next);
      setPosition(0);
      setDuration(next.duration ?? 0);
      setPlaying(true);
      // 手动点播的也记进"放过了"：不然自动续播会把用户刚听完的那首再接一遍
      markPlayed(next.id);
    };
    window.addEventListener(PLAY_EVENT, onPlay);
    return () => window.removeEventListener(PLAY_EVENT, onPlay);
  }, []);

  // 放到一首还没分析的歌 → 让它插队分析。去重、和"选中即分析"共享一份
  // 排队记号的逻辑都在 autoAnalyze 里，这里只负责把"在放哪一首"告诉它。
  useEffect(() => {
    if (track) analyzePlaying(track);
  }, [track?.id, track?.analyzed_at]);

  // 换曲：换 src 后必须 load()，否则 Chromium 会继续放上一首的缓冲
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !track) return;
    audio.src = api.audioUrl(track.id);
    audio.load();
    setNotice("");
    if (playing) {
      audio.play().catch((error: unknown) => {
        setPlaying(false);
        setNotice(`播放失败：${(error as Error).message}`);
      });
    }
    // playing 不进依赖：它变化时由下面的 effect 处理，这里只管换曲
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track?.id]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !track) return;
    if (playing) {
      audio.play().catch(() => setPlaying(false));
    } else {
      audio.pause();
    }
  }, [playing, track]);

  // 不做音量控制：这里只是预听，音量交给系统。软件里再放一个滑块只是多一个要照看的东西。

  // 详情页点波形跳转
  useEffect(() => {
    const onSeek = (event: Event) => {
      const detail = (event as CustomEvent<SeekDetail>).detail;
      const audio = audioRef.current;
      if (!audio || !track || detail.trackId !== track.id) return;
      audio.currentTime = detail.position;
      setPosition(detail.position);
    };
    window.addEventListener(SEEK_EVENT, onSeek);
    return () => window.removeEventListener(SEEK_EVENT, onSeek);
  }, [track]);

  const broadcast = useCallback(
    (seconds: number) => {
      if (!track) return;
      const now = performance.now();
      if (now - lastBroadcast.current < POSITION_BROADCAST_MS) return;
      lastBroadcast.current = now;
      window.dispatchEvent(
        new CustomEvent<PositionDetail>(POSITION_EVENT, {
          detail: { trackId: track.id, position: seconds },
        }),
      );
    },
    [track],
  );

  // 跳转统一由 Waveform 发 kd:seek 事件，上面那个监听负责落到 <audio> 上

  return (
    <div className="kd-player">
      <audio
        ref={audioRef}
        preload="metadata"
        onTimeUpdate={(event) => {
          const seconds = event.currentTarget.currentTime;
          setPosition(seconds);
          broadcast(seconds);
        }}
        onLoadedMetadata={(event) => {
          const value = event.currentTarget.duration;
          // 无损/VBR 文件偶尔给 Infinity，这时退回曲库里存的时长
          if (Number.isFinite(value) && value > 0) setDuration(value);
        }}
        onEnded={() => {
          setPosition(0);
          // 自动续播：从和声推荐里挑一首没放过的接上。
          // 先把"当前这首放完了"记下来再挑，否则它自己会出现在候选里。
          const finished = track;
          if (!finished) {
            setPlaying(false);
            return;
          }
          markPlayed(finished.id);
          void pickNext(finished).then((next) => {
            if (!next) {
              // 推荐池空了（曲库太小 / 都放过了）就安静停下，不报错
              setPlaying(false);
              return;
            }
            // 走和双击列表同一条路：播放器不必知道谁触发了播放
            playTrack(next);
          });
        }}
        onError={() => {
          if (track) {
            setPlaying(false);
            setNotice("这个文件放不了，可能已被移动，或者格式浏览器不支持");
          }
        }}
      />

      {/* 登录入口在列表标签行最右侧的「登录」，播放条不再放齿轮 */}

      {/* 播放/停止合成一个键：一次点击只有一个含义，出场时不会点错 */}
      <button
        type="button"
        className="kd-player-btn"
        aria-label={playing ? "停止" : "播放"}
        disabled={!track && !selected}
        onClick={() => {
          // 还没有在播的曲子时，播的就是曲库里当前选中的那首——
          // 「选中 → 按下面的播放」和双击是等价的两条路。
          if (!track) {
            if (selected) playTrack(selected);
            return;
          }
          const audio = audioRef.current;
          if (playing && audio) audio.currentTime = 0; // 停止就是回到开头，和按钮上的图标一致
          setPlaying((value) => !value);
          if (playing) setPosition(0);
        }}
      >
        {playing ? <Square size={13} fill="currentColor" /> : <Play size={15} fill="currentColor" />}
      </button>

      {/* 唱片占位常驻：没有它的话，换一首歌时封面会"啪"地冒出来再把右边的字挤走。
          占位始终在，封面加载好了盖在上面，布局从头到尾不动。 */}
      <span className="kd-player-disc" aria-hidden="true">
        <Disc3 size={18} />
        {track && (
          <img
            src={api.coverUrl(track.id)}
            alt=""
            onError={(event) => {
              event.currentTarget.style.opacity = "0";
            }}
            onLoad={(event) => {
              event.currentTarget.style.opacity = "1";
            }}
          />
        )}
      </span>

      {/* 曲名一行就够；艺人、BPM、调号在曲库详情里都有，底部条不复述。
          出错时这一格要多分点宽度，不然一句话只剩三个字加省略号。 */}
      <div className="kd-player-meta" data-notice={notice ? "true" : undefined}>
        <div className="kd-player-title">
          {track ? track.title || track.filename : selected ? selected.title || selected.filename : "没有在播的曲目"}
        </div>
        <InlineNotice text={notice} onDismiss={() => setNotice("")} />
      </div>

      <div className="kd-player-scrub">
        {/* 进度条就是波形本身：DJ 软件都是这么做的，看一眼就知道下一个 drop 还有多远 */}
        {track ? (
          <Waveform
            className="kd-player-wave"
            trackId={track.id}
            position={position}
            height={30}
            dimPlayed
          />
        ) : (
          <div className="kd-player-wave" style={{ height: 30, background: "var(--kd-panel-inset)" }} />
        )}
        <span className="kd-nowrap">
          {formatDuration(position)} / {formatDuration(duration)}
        </span>
      </div>
    </div>
  );
}
