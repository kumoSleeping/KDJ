export type NativeAudioStatus = 'idle' | 'loading' | 'playing' | 'ended' | 'error';

export type NativeAudioState = {
  id?: number | null;
  status: NativeAudioStatus;
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  buffering: boolean;
  rate: number;
  error?: string;
};

export type NativeAudioSetSourcePayload = {
  src: string;
  id?: number;
  title?: string;
  artist?: string;
  album?: string;
  artworkUrl?: string;
};

export type NativeAudioProgressCheckpoint = {
  id: number;
  currentTime: number;
  updatedAtMs: number;
  status?: 'idle' | 'loading' | 'playing' | 'ended' | 'error';
};

export declare const initialize: () => Promise<NativeAudioState>;
export declare const setSource: (payload: NativeAudioSetSourcePayload) => Promise<NativeAudioState>;
export declare const setQueue: (items: NativeAudioSetSourcePayload[]) => Promise<NativeAudioState>;
export declare const play: () => Promise<NativeAudioState>;
export declare const pause: () => Promise<NativeAudioState>;
export declare const seekTo: (position: number) => Promise<NativeAudioState>;
export declare const setRate: (rate: number) => Promise<NativeAudioState>;
export declare const setVolume: (volume: number) => Promise<NativeAudioState>;
export declare const getState: () => Promise<NativeAudioState>;
export declare const getProgressCheckpoint: () => Promise<NativeAudioProgressCheckpoint | null>;
export declare const clearProgressCheckpoint: () => Promise<void>;
export declare const dispose: () => Promise<void>;
export declare const addStateListener: (handler: (state: NativeAudioState) => void) => Promise<() => void>;

export type NativeLyricsWord = {
  start: number;
  end: number;
  text: string;
};

/** 一行歌词；`secondary` 是翻译或罗马音，由调用方按当前附加层选好。 */
export type NativeLyricsLine = {
  time: number;
  endTime?: number;
  text: string;
  secondary?: string;
  words?: NativeLyricsWord[];
};

export type NativeLyricsTimelinePayload = {
  /** 与播放器当前曲目比对，防止切歌瞬间把上一首的词继续滚下去。 */
  trackId?: number | null;
  duration?: number;
  /** 搜词中 / 没有歌词时的兜底文案。 */
  placeholder?: string;
  lines: NativeLyricsLine[];
};

/** 浏览器试听的外部时钟；仅接受负 ID，null 用于清除旧流。 */
export type NativeLyricsPlaybackClockPayload = {
  trackId?: number | null;
  position?: number;
  duration?: number;
  playing?: boolean;
  rate?: number;
};

export type NativeLyricsColorMode = 'black' | 'white' | 'gray' | 'solid' | 'gradient' | 'none' | 'follow';

export type NativeLyricsOverlayPayload = {
  visible: boolean;
  position: 'top' | 'bottom';
  locked: boolean;
  fontScale?: number;
  /** 逐字高亮色，`#RRGGBB`；缺省为白。 */
  accent?: string;
  accentEnd?: string;
  accentMode?: NativeLyricsColorMode;
  secondaryAccent?: string;
  secondaryAccentEnd?: string;
  secondaryMode?: NativeLyricsColorMode;
  /** 未唱部分颜色。 */
  dim?: string;
  dimEnd?: string;
  dimMode?: NativeLyricsColorMode;
  stroke?: string;
  strokeEnd?: string;
  strokeMode?: NativeLyricsColorMode;
  opacity?: number;
  /** 只有换边或重新打开时才吸附，否则会抹掉用户拖出来的位置。 */
  reposition?: boolean;
  y?: number | null;
};

/** `granted=false` 表示「显示在其他应用上层」权限没到位，开关不能算已打开。 */
export type NativeLyricsOverlayResult = {
  visible: boolean;
  granted: boolean;
};

export type NativeLyricsOverlayMoved = {
  position: 'top' | 'bottom';
  y: number;
};

export declare const setLyricsTimeline: (payload: NativeLyricsTimelinePayload) => Promise<void>;
export declare const setLyricsPlaybackClock: (
  payload: NativeLyricsPlaybackClockPayload,
) => Promise<void>;
export declare const setLyricsOverlay: (
  payload: NativeLyricsOverlayPayload,
) => Promise<NativeLyricsOverlayResult>;
export declare const checkOverlayPermission: () => Promise<{ granted: boolean }>;
export declare const requestOverlayPermission: () => Promise<{ granted: boolean }>;
export declare const addOverlayMovedListener: (
  handler: (moved: NativeLyricsOverlayMoved) => void,
) => Promise<() => void>;

export type SavedGalleryPng = {
  path: string;
  displayPath?: string;
  location: string;
};

export declare const savePngToGallery: (payload: {
  platform: string;
  label: string;
  image: string;
}) => Promise<SavedGalleryPng>;
export declare const openLocalPath: (path: string) => Promise<void>;
/** 安卓：把已有本地文件作为 content URI 启动跨窗口系统拖动。 */
export declare const startFileDrag: (
  paths: string[],
  label: string,
) => Promise<{ started: true }>;
/** 安卓：系统文件夹选择器；取消返回 null。 */
export declare const pickLibraryFolder: () => Promise<string | null>;
