import { useEffect, useMemo, useRef, useState } from "react";
import { Select } from "../common/Select";
import { ChevronDown, ChevronRight, Copy, Download, FolderOpen, RefreshCw, Trash2 } from "lucide-react";
import {
  enginesFromMode,
  enginesMode,
  useLyricsPrefs,
  type LyricsEngineMode,
} from "../../lib/lyricsPrefs";
import {
  TEMPO_RANGE_OPTIONS,
  usePlaybackPrefs,
  type LocalExternalDragMode,
  type TempoRange,
  type TimeDisplayMode,
} from "../../lib/playbackPrefs";
import { useArrowKeyControl } from "../../lib/arrowKeyControl";
import {
  APP_FONT_SCALE_MAX,
  APP_FONT_SCALE_MIN,
  readAppFontScale,
  setAppFontScale,
  type AppFontScale,
} from "../../lib/fontScale";
import { api } from "../../lib/api";
import {
  installOfficialTheme,
  optionValues,
  refreshThemePacks,
  selectThemePack,
  setThemeOption,
  useThemePack,
} from "../../lib/themePack";
import { getBridge } from "../../lib/bridge";
import { copyText } from "../../lib/copyText";
import { formatBytes } from "../../lib/format";
import { createKdjAiPrompt } from "../../lib/kdjAiPrompt";
import { patchEnabledPlatform } from "../../lib/enabledPlatforms";
import { normalizeEnabledPlatforms, SEARCH_PLATFORMS } from "../../lib/searchPlatforms";
import { clearStreamAnalysisCache } from "../../lib/streamAnalysis";
import { clearStreamCacheProgressCache } from "../../lib/streamCacheProgress";
import { useSharePrefs, type ShareContentMode } from "../../lib/sharePrefs";
import { clearAllWaveformCaches } from "../../lib/waveformCache";
import { useAppStore } from "../../stores/appStore";
import { useLibraryStore } from "../../stores/libraryStore";
import { useLyricsStore } from "../../stores/lyricsStore";
import type {
  ActivityLogSettings,
  CacheCategory,
  CacheCategoryStats,
  CacheOverview,
  CliInstallStatus,
  KeyNotation,
  Quality,
  StreamCacheStats,
} from "../../types";
import { useUpdateStore } from "../../stores/updateStore";
import { Button, InlineNotice, Panel } from "../common";
import { AccountRow } from "./AccountRow";
import { ActivityLogPanel } from "./ActivityLogPanel";
import { UpdateRow } from "./UpdateRow";
import { FfmpegPanel } from "./FfmpegPanel";

/**
 * 「设置」住在右侧详情栏，由顶栏那颗小齿轮呼出。
 *
 * General 含外观（无小标题）、列表手势与接播（小标题）。流媒体与歌词同板，歌词保留小标题。
 */

function Switch({
  checked,
  onChange,
  label,
  title,
  disabled = false,
  onState = "开",
  offState = "关",
}: {
  checked: boolean;
  onChange(): void;
  label: string;
  title?: string;
  disabled?: boolean;
  /** 右侧文案；开/关用默认，双击/单击等二元模式可覆写。 */
  onState?: string;
  offState?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-disabled={disabled || undefined}
      title={title}
      className="kd-djp-toggle"
      disabled={disabled}
      onClick={onChange}
    >
      <span className="kd-djp-toggle-label">{label}</span>
      <span className="kd-djp-toggle-state" aria-hidden="true" data-onoff={checked ? "on" : "off"}>
        {checked ? onState : offState}
      </span>
    </button>
  );
}

const CACHE_CATEGORY_LABEL: Record<CacheCategory | "other", string> = {
  media: "媒体",
  waveform: "波形",
  lyrics: "歌词",
  basic: "基本信息",
  logs: "日志",
  other: "其他",
};

function cacheCategoryDetail(category: CacheCategory | "other", stats: CacheCategoryStats): string {
  const count = category === "basic"
    ? `调性 / 响度 / BPM · ${stats.items} 首`
    : category === "logs"
      ? `最近 ${stats.items} 条 · ${stats.files} 个文件`
      : `${stats.files} 个文件`;
  const size = stats.bytes > 0
    ? `${stats.estimated ? "约 " : ""}${formatBytes(stats.bytes)}`
    : "0 B";
  const active = stats.active > 0
    ? category === "basic"
      ? ` · ${stats.active} 个任务运行中`
      : ` · ${stats.active} 首写入中`
    : "";
  return `${count} · ${size}${active}`;
}

function CacheOverviewRow({
  category,
  stats,
  busy,
  confirming,
  onClear,
}: {
  category: CacheCategory | "other";
  stats: CacheCategoryStats;
  busy: boolean;
  confirming: boolean;
  onClear(category: CacheCategory): void;
}) {
  const empty = stats.items === 0 && stats.files === 0 && stats.bytes === 0 && stats.active === 0;
  return (
    <div className="kd-cache-overview-row" data-confirming={confirming || undefined}>
      <span className="kd-cache-overview-copy">
        <span className="kd-cache-overview-label">{CACHE_CATEGORY_LABEL[category]}</span>
        <span className="kd-cache-overview-detail">{cacheCategoryDetail(category, stats)}</span>
      </span>
      {category !== "other" ? (
        <Button
          variant="ghost"
          size="sm"
          disabled={busy || empty}
          className="kd-cache-overview-clear"
          data-confirming={confirming || undefined}
          aria-label={confirming
            ? `再次点击确认清理${CACHE_CATEGORY_LABEL[category]}`
            : `清理${CACHE_CATEGORY_LABEL[category]}`}
          title={confirming ? "再次点击才会真正清理" : "第一次点击进入确认状态"}
          onClick={() => onClear(category)}
        >
          <Trash2 size={12} aria-hidden="true" />
          {confirming ? "再次点击" : "清理"}
        </Button>
      ) : null}
    </div>
  );
}

/** 左文右态：点击右侧文案循环搜词引擎模式。 */
function CycleToggle<T extends string | number>({
  label,
  value,
  options,
  onChange,
  title,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ id: T; text: string; brand?: "wyy" | "qqm" | "both" | "follow" }>;
  onChange(next: T): void;
  title?: string;
}) {
  const index = Math.max(
    0,
    options.findIndex((item) => item.id === value),
  );
  const current = options[index]!;
  return (
    <button
      type="button"
      aria-label={`${label}：${current.text}`}
      title={title}
      className="kd-djp-toggle"
      onClick={() => onChange(options[(index + 1) % options.length]!.id)}
    >
      <span className="kd-djp-toggle-label">{label}</span>
      <span
        className="kd-djp-toggle-state"
        aria-hidden="true"
        data-brand={current.brand}
      >
        {current.text}
      </span>
    </button>
  );
}

const ENGINE_MODE_OPTIONS = [
  { id: "all" as const, text: "全部", brand: "both" as const },
  { id: "wyy" as const, text: "网易云", brand: "wyy" as const },
  { id: "qqm" as const, text: "QQ", brand: "qqm" as const },
  { id: "ytm" as const, text: "YTM", brand: "both" as const },
] satisfies ReadonlyArray<{
  id: LyricsEngineMode;
  text: string;
  brand: "both" | "wyy" | "qqm";
}>;

/** 主界面字号：不再使用连续滑条，每次明确增减 5%。 */
function FontScaleStepper({
  value,
  onChange,
}: {
  value: AppFontScale;
  onChange(next: AppFontScale): void;
}) {
  const choose = (nextValue: number) => {
    onChange(Math.max(APP_FONT_SCALE_MIN, Math.min(APP_FONT_SCALE_MAX, Math.round(nextValue))));
  };

  return (
    <div
      className="kd-djp-font-stepper"
      role="group"
      aria-label="界面字号"
      title="调整主界面的文字大小。"
    >
      <span className="kd-djp-font-copy">
        <span className="kd-djp-toggle-label">界面字号</span>
        <output className="kd-djp-font-value kd-num" aria-live="polite">
          {value}%
        </output>
      </span>
      <span className="kd-djp-font-actions">
        <button
          type="button"
          disabled={value <= APP_FONT_SCALE_MIN}
          aria-label="界面字号减小 5%"
          title="减小 5%"
          onClick={() => choose(value - 5)}
        >
          −
        </button>
        <button
          type="button"
          disabled={value >= APP_FONT_SCALE_MAX}
          aria-label="界面字号增大 5%"
          title="增大 5%"
          onClick={() => choose(value + 5)}
        >
          +
        </button>
      </span>
    </div>
  );
}

/** 主题包：数据目录 themes/ 下的文件夹。打开面板时重扫一次，不常驻监听。 */
function ThemePackRows() {
  const { dir, packs, official, installing, selection, active, error } = useThemePack();
  useEffect(() => {
    // Opening settings only rescans the list; reloading would briefly remove the active CSS.
    void refreshThemePacks(false);
  }, []);
  const mode = useAppStore(state => state.settings?.theme ?? "system");
  const saveSettings = useAppStore(state => state.saveSettings);
  const selected = selection.id ?? (mode === "system"
    ? `builtin-${document.documentElement.dataset.theme ?? "light"}` : `builtin-${mode}`);
  const choose = async (value: string) => {
    try {
      if (value === "builtin-light" || value === "builtin-dark") {
        await selectThemePack(null);
        await saveSettings({ theme: value === "builtin-light" ? "light" : "dark" });
      } else await selectThemePack(value);
    } catch (cause) {
      useThemePack.setState({ error: (cause as Error).message });
    }
  };
  const values = active ? optionValues(active, selection.options[active.id]) : {};
  return (
    <>
      <div className="kd-djp-font-stepper kd-theme-row" role="group" aria-label="主题">
        <span className="kd-djp-font-copy">
          <span className="kd-djp-toggle-label">主题</span>
        </span>
        <span className="kd-djp-font-actions">
          <span className="kd-theme-select">
          <Select
            className="kd-select"
            disabled={installing !== null}
            aria-label="主题"
            value={selected}
            onChange={(event) => void choose(event.target.value)}
          >
            <option value="builtin-light">Shiro</option>
            <option value="builtin-dark">Dark</option>
            {/* 选中的包不在了也留着这一项：把文件夹放回来就恢复，不悄悄改掉用户的选择 */}
            {selection.id && !packs.some((pack) => pack.dir === selected) ? (
              <option value={selected}>{selected}</option>
            ) : null}
            {packs.map((pack) => (
              <option key={pack.dir} value={pack.dir}>{official.find(item => item.id === pack.dir)?.name ?? pack.manifest?.name ?? pack.dir}</option>
            ))}
          </Select>
          </span>
          {dir ? (
            <button
              type="button"
              aria-label="打开主题文件夹"
              title="打开主题文件夹"
              onClick={() => void window.kdj?.openPath(dir).catch(() => undefined)}
            >
              <FolderOpen size={14} />
            </button>
          ) : null}
        </span>
      </div>
      <div className="kd-theme-official">
        {official.map(theme => {
          const installed = packs.some(pack => pack.dir === theme.id && pack.manifest);
          return (
            <div className="kd-theme-official-row" key={theme.id}>
              <span>{theme.name}<small>官方</small></span>
              <button type="button" className="kd-btn" data-variant="ghost"
                disabled={installing !== null}
                aria-label={`${installed ? "更新" : "下载"}${theme.name}`}
                onClick={() => void installOfficialTheme(theme.id)}>
                <Download size={13} aria-hidden="true" />
                {installing === theme.id ? "下载中…" : installed ? "更新" : "下载"}
              </button>
            </div>
          );
        })}
      </div>
      {active && active.options.length > 0 ? (
        <div className="kd-djp-switch-list" aria-label="主题选项">
          {active.options.map((option) => (
            <Switch
              key={option.id}
              checked={values[option.id]}
              label={option.label}
              onChange={() => void setThemeOption(option.id, !values[option.id])}
            />
          ))}
        </div>
      ) : null}
      <InlineNotice text={error} block />
    </>
  );
}

function SettingsExpandToggle({
  expanded,
  onToggle,
  label,
}: {
  expanded: boolean;
  onToggle(): void;
  label: string;
}) {
  return (
    <button
      type="button"
      className="kd-djp-section-toggle"
      aria-expanded={expanded}
      aria-label={expanded ? `收起${label}` : `展开${label}`}
      title={expanded ? "收起" : "展开"}
      onClick={onToggle}
    >
      {expanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
    </button>
  );
}

function KdjAiPromptPanel() {
  const bridge = getBridge();
  const [cliStatus, setCliStatus] = useState<CliInstallStatus | null>(null);
  const [cliBusy, setCliBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [ok, setOk] = useState(false);
  const prompt = useMemo(
    () => createKdjAiPrompt(cliStatus?.invocation ?? "kdj"),
    [cliStatus?.invocation],
  );

  useEffect(() => {
    let disposed = false;
    const readStatus = bridge.cliInstallStatus;
    if (!readStatus) return;
    setCliBusy(true);
    void readStatus()
      .then((status) => {
        if (disposed) return;
        setCliStatus(status);
      })
      .catch((error) => {
        if (disposed) return;
        setOk(false);
        setNotice(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!disposed) setCliBusy(false);
      });
    return () => {
      disposed = true;
    };
  }, [bridge]);

  const installCli = () => {
    const install = bridge.installCli;
    if (!install || cliBusy) return;
    setCliBusy(true);
    setNotice("");
    setOk(false);
    void install()
      .then((status) => {
        setCliStatus(status);
        setOk(true);
        setNotice(`CLI 已安装 · v${status.installedVersion ?? status.currentVersion}`);
      })
      .catch((error) => {
        setOk(false);
        setNotice(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setCliBusy(false));
  };

  const copyPrompt = () => {
    setNotice("");
    setOk(false);
    void copyText(prompt)
      .then(() => {
        setOk(true);
        setNotice("已复制完整 Prompt");
      })
      .catch((error) => {
        setOk(false);
        setNotice(error instanceof Error ? error.message : String(error));
      });
  };

  const installedVersion = cliStatus?.installedVersion;
  const cliState = (() => {
    if (!cliStatus) return { label: "正在检测 CLI…", detail: "", action: "" };
    switch (cliStatus.state) {
      case "current":
        return {
          label: `CLI 已安装 · v${installedVersion ?? cliStatus.currentVersion}`,
          detail: "与当前版本一致",
          action: "",
        };
      case "outdated":
        return {
          label: `CLI 已安装 · v${installedVersion ?? "未知"}`,
          detail: `当前 v${cliStatus.currentVersion}`,
          action: "更新 CLI",
        };
      case "broken":
        return {
          label: "CLI 入口失效",
          detail: `当前 v${cliStatus.currentVersion}`,
          action: "更新 CLI",
        };
      case "conflict":
        return {
          label: "CLI 安装位置已被其他命令占用",
          detail: cliStatus.installPath,
          action: "",
        };
      case "missing":
        return {
          label: "CLI 未安装",
          detail: `当前 v${cliStatus.currentVersion}`,
          action: "安装 CLI",
        };
      default:
        return { label: "当前平台不支持 CLI", detail: "", action: "" };
    }
  })();

  return (
    <Panel heading="让 AI 操作 KDJ" dense>
      <div className="kd-ai-prompt">
        <div className="kd-cli-install-row" title={cliStatus?.installPath}>
          <span className="kd-cli-install-copy">
            <strong>{cliState.label}</strong>
            {cliState.detail ? <small>{cliState.detail}</small> : null}
          </span>
          {cliState.action ? (
            <Button variant="ghost" size="sm" disabled={cliBusy} onClick={installCli}>
              {cliStatus?.state === "missing" ? (
                <Download size={12} aria-hidden="true" />
              ) : (
                <RefreshCw size={12} aria-hidden="true" />
              )}
              {cliBusy ? "处理中…" : cliState.action}
            </Button>
          ) : null}
        </div>
        <p className="kd-ai-prompt-copy">把下面整段发给 AI，它会先读取当前 CLI 能力，再操作 KDJ。</p>
        <textarea
          className="kd-textarea kd-ai-prompt-textarea"
          value={prompt}
          readOnly
          spellCheck={false}
          aria-label="KDJ AI 操作 Prompt"
        />
        <div className="kd-ai-prompt-actions">
          <Button variant="ghost" size="sm" disabled={!cliStatus || cliBusy} onClick={copyPrompt}>
            <Copy size={12} aria-hidden="true" />
            复制 Prompt
          </Button>
        </div>
      </div>
      <InlineNotice
        text={notice}
        tone={ok ? "ok" : "warn"}
        onDismiss={() => {
          setNotice("");
          setOk(false);
        }}
      />
    </Panel>
  );
}

export function SettingsPanel() {
  const showKdjAiPrompt = ["darwin", "win32"].includes(getBridge().platform);
  const settings = useAppStore((state) => state.settings);
  const saveSettings = useAppStore((state) => state.saveSettings);
  const [appFontScale, setFontScale] = useState(readAppFontScale);
  const [streamCacheStats, setStreamCacheStats] = useState<StreamCacheStats | null>(null);
  const [streamCacheBusy, setStreamCacheBusy] = useState(false);
  const [streamCacheError, setStreamCacheError] = useState("");
  const [cacheOverview, setCacheOverview] = useState<CacheOverview | null>(null);
  const [cacheBusy, setCacheBusy] = useState<CacheCategory | null>(null);
  const [cacheConfirm, setCacheConfirm] = useState<CacheCategory | null>(null);
  const [cacheError, setCacheError] = useState("");
  const [activityLogSettings, setActivityLogSettings] = useState<ActivityLogSettings | null>(null);
  const [activityLogSettingsBusy, setActivityLogSettingsBusy] = useState(false);
  const [activityLogSettingsError, setActivityLogSettingsError] = useState("");
  const [lyricsExpanded, setLyricsExpanded] = useState(false);

  const transportFade = usePlaybackPrefs((state) => state.transportFade);
  const setTransportFade = usePlaybackPrefs((state) => state.setTransportFade);
  const tempoRange = usePlaybackPrefs((state) => state.tempoRange);
  const setTempoRange = usePlaybackPrefs((state) => state.setTempoRange);
  const timeDisplayMode = usePlaybackPrefs((state) => state.timeDisplayMode);
  const setTimeDisplayMode = usePlaybackPrefs((state) => state.setTimeDisplayMode);
  const localExternalDragMode = usePlaybackPrefs((state) => state.localExternalDragMode);
  const setLocalExternalDragMode = usePlaybackPrefs((state) => state.setLocalExternalDragMode);
  const arrowKeyControlEnabled = useArrowKeyControl((state) => state.enabled);
  const setArrowKeyControlEnabled = useArrowKeyControl((state) => state.setEnabled);
  const horizontalArrowKeyMode = useArrowKeyControl((state) => state.horizontalMode);
  const setHorizontalArrowKeyMode = useArrowKeyControl((state) => state.setHorizontalMode);
  const verticalArrowKeyMode = useArrowKeyControl((state) => state.verticalMode);
  const setVerticalArrowKeyMode = useArrowKeyControl((state) => state.setVerticalMode);
  const shareContentMode = useSharePrefs((state) => state.contentMode);
  const setShareContentMode = useSharePrefs((state) => state.setContentMode);
  const lyricsEngines = useLyricsPrefs((state) => state.engines);
  const setLyricsEngines = useLyricsPrefs((state) => state.setEngines);
  const tryOnlineWhenMissing = useLyricsPrefs((state) => state.tryOnlineWhenMissing);
  const setTryOnlineWhenMissing = useLyricsPrefs((state) => state.setTryOnlineWhenMissing);

  const accounts = useAppStore((state) => state.accounts);
  const accountsError = useAppStore((state) => state.accountsError);
  const verifyAccountsIfStale = useAppStore((state) => state.verifyAccountsIfStale);
  const settingsError = useAppStore((state) => state.settingsError);
  const refreshLibrary = useLibraryStore((state) => state.refresh);
  const refreshLibraryStats = useLibraryStore((state) => state.refreshStats);

  useEffect(() => {
    // 启动只读离线快照；账号设置挂载后静默核验。Store 同时做 single-flight 与
    // 半小时冷却，StrictMode 或反复开关面板都不会频繁请求第三方平台。
    void verifyAccountsIfStale();
  }, [verifyAccountsIfStale]);

  useEffect(() => {
    let disposed = false;
    const refresh = () => {
      void Promise.allSettled([
        api.streamCacheStats(),
        api.cacheOverview(),
        api.activityLogSettings(),
      ]).then((results) => {
        if (disposed) return;
        const [streamResult, overviewResult, logSettingsResult] = results;
        if (streamResult.status === "fulfilled") {
          setStreamCacheStats(streamResult.value);
          setStreamCacheError("");
        } else {
          setStreamCacheError(
            streamResult.reason instanceof Error
              ? streamResult.reason.message
              : String(streamResult.reason),
          );
        }
        if (overviewResult.status === "fulfilled") {
          setCacheOverview(overviewResult.value);
          setCacheError("");
        } else {
          setCacheError(
            overviewResult.reason instanceof Error
              ? overviewResult.reason.message
              : String(overviewResult.reason),
          );
        }
        if (logSettingsResult.status === "fulfilled") {
          setActivityLogSettings(logSettingsResult.value);
          setActivityLogSettingsError("");
        } else {
          setActivityLogSettingsError(
            logSettingsResult.reason instanceof Error
              ? logSettingsResult.reason.message
              : String(logSettingsResult.reason),
          );
        }
      });
    };
    refresh();
    // 关闭/清理后仍短轮询：在途 writer 会异步收尾，不能把“缓存中”永久留在 UI。
    // stats 会枚举缓存目录；设置面板停留时无需每 3 秒唤醒下载盘。
    const timer = window.setInterval(refresh, 10_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [settings?.download_dir, settings?.stream_cache_enabled]);

  useEffect(() => {
    if (!cacheConfirm) return;
    const timer = window.setTimeout(() => setCacheConfirm(null), 4_000);
    return () => window.clearTimeout(timer);
  }, [cacheConfirm]);

  const toggleStreamCache = async () => {
    if (!settings || streamCacheBusy) return;
    setStreamCacheBusy(true);
    setStreamCacheError("");
    try {
      await saveSettings({ stream_cache_enabled: !settings.stream_cache_enabled });
      setStreamCacheStats(await api.streamCacheStats());
    } catch (error) {
      setStreamCacheError(error instanceof Error ? error.message : String(error));
    } finally {
      setStreamCacheBusy(false);
    }
  };

  const clearCache = async (category: CacheCategory) => {
    if (cacheBusy) return;
    if (cacheConfirm !== category) {
      setCacheConfirm(category);
      return;
    }
    setCacheConfirm(null);
    setCacheBusy(category);
    setCacheError("");
    try {
      const overview = await api.clearCacheCategory(category);
      setCacheOverview(overview);
      if (category === "media") {
        clearStreamCacheProgressCache();
        setStreamCacheStats(await api.streamCacheStats());
      } else if (category === "waveform") {
        clearAllWaveformCaches();
      } else if (category === "lyrics") {
        useLyricsStore.getState().clear();
      } else if (category === "basic") {
        clearStreamAnalysisCache();
        await Promise.all([refreshLibrary(), refreshLibraryStats()]);
      }
    } catch (error) {
      setCacheError(error instanceof Error ? error.message : String(error));
    } finally {
      setCacheBusy(null);
    }
  };

  const changeActivityLogRetention = async (
    retentionDays: ActivityLogSettings["retention_days"],
  ) => {
    if (activityLogSettingsBusy) return;
    setActivityLogSettingsBusy(true);
    setActivityLogSettingsError("");
    try {
      setActivityLogSettings(
        await api.updateActivityLogSettings({ retention_days: retentionDays }),
      );
      setCacheOverview(await api.cacheOverview());
    } catch (error) {
      setActivityLogSettingsError(error instanceof Error ? error.message : String(error));
    } finally {
      setActivityLogSettingsBusy(false);
    }
  };

  // 各平台账号与下载源开关合并在同一面板。
  const accountsByPlatform = useMemo(
    () => new Map(accounts.map((account) => [account.platform, account])),
    [accounts],
  );
  const autoCheck = useUpdateStore((s) => s.autoCheck);
  const setAutoCheck = useUpdateStore((s) => s.setAutoCheck);
  const focusEpoch = useUpdateStore((s) => s.focusEpoch);
  const updateSectionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!focusEpoch) return;
    let frame = 0;
    const scrollToUpdate = () => {
      const section = updateSectionRef.current;
      if (!section) {
        if (frame++ < 8) requestAnimationFrame(scrollToUpdate);
        return;
      }
      const scrollHost = section.closest(".kd-scroll") as HTMLElement | null;
      if (!scrollHost) return;
      const top =
        section.getBoundingClientRect().top -
        scrollHost.getBoundingClientRect().top +
        scrollHost.scrollTop;
      scrollHost.scrollTo({ top: Math.max(0, top), behavior: frame > 0 ? "auto" : "smooth" });
    };
    scrollToUpdate();
  }, [focusEpoch]);

  return (
    <div className="kd-col" style={{ height: "100%", minHeight: 0 }}>
      <div className="kd-scroll kd-djp" style={{ minHeight: 0 }}>
        <InlineNotice text={settingsError} block />
        <div ref={updateSectionRef} id="kd-settings-update">
          <Panel heading="软件更新" dense>
            <UpdateRow />
            <div className="kd-djp-switch-list" style={{ marginTop: "0.35rem" }}>
              <Switch
                checked={autoCheck}
                label="自动检测更新"
                title="启动时检查一次，之后每 5 分钟静默检查；关掉后只保留手动检查。"
                onChange={() => setAutoCheck(!autoCheck)}
              />
            </div>
          </Panel>
        </div>

        <Panel heading="General" dense>
          <div className="kd-djp-groups" aria-label="General">
            <div>
              <FontScaleStepper
                value={appFontScale}
                onChange={(next) => {
                  setFontScale(next);
                  setAppFontScale(next);
                }}
              />
              <ThemePackRows />
            </div>
            <div className="kd-djp-switch-list" aria-label="列表与播放">
              <CycleToggle<KeyNotation>
                label="列表调性"
                value={settings?.key_notation ?? "camelot"}
                options={[
                  { id: "camelot", text: "Camelot" },
                  { id: "traditional", text: "音名" },
                ]}
                title="歌曲列表统一显示 Camelot 数字制或传统音名；不会改写曲目数据。"
                onChange={(next) => void saveSettings({ key_notation: next }).catch(() => undefined)}
              />
              <Switch
                checked={transportFade}
                label="播放 / 暂停渐入渐出"
                title="播放时用约 120 毫秒渐入，暂停时用约 120 毫秒渐出；关掉后立即播放或暂停。"
                onChange={() => setTransportFade(!transportFade)}
              />
              <CycleToggle<TimeDisplayMode>
                label="计时方式"
                value={timeDisplayMode}
                options={[
                  { id: "elapsed", text: "正计时" },
                  { id: "remaining", text: "倒计时" },
                ]}
                title="播放条显示已经播放的时间，或显示距离歌曲结束的剩余时间。"
                onChange={setTimeDisplayMode}
              />
              <CycleToggle<TempoRange>
                label="Tempo 最大范围"
                value={tempoRange}
                options={TEMPO_RANGE_OPTIONS.map((value) => ({ id: value, text: `±${value}%` }))}
                title="管理模式当前歌曲的 Tempo 滑杆相对原速可调整的最大范围。"
                onChange={setTempoRange}
              />
              <CycleToggle<LocalExternalDragMode>
                label="本地歌曲外拖"
                value={localExternalDragMode}
                options={[
                  { id: "file", text: "歌曲文件" },
                  { id: "share_link", text: "分享链接" },
                ]}
                title="本地歌曲拖出 KDJ 时，选择交给其他应用真实歌曲文件或可公开打开的来源链接。"
                onChange={setLocalExternalDragMode}
              />
              <CycleToggle<ShareContentMode>
                label="分享内容"
                value={shareContentMode}
                options={[
                  { id: "link_only", text: "原链接" },
                  { id: "song_info", text: "包含信息" },
                  { id: "more_info", text: "更多信息" },
                ]}
                title="原链接仅分享网址；包含信息会附上歌曲名与艺术家；更多信息沿用相同文字，并额外附上 Share from KDJ 版本水印和小尺寸缩略封面。"
                onChange={setShareContentMode}
              />
            </div>
          </div>
        </Panel>

        <Panel heading="快捷键方向键控制" dense>
          <div className="kd-djp-switch-list" aria-label="快捷键方向键控制">
            <Switch
              checked={arrowKeyControlEnabled}
              label="启用"
              title="开启后由 KDJ 接管四个方向键；关闭后方向键保留给当前界面。"
              onChange={() => setArrowKeyControlEnabled(!arrowKeyControlEnabled)}
            />
            <Switch
              checked={horizontalArrowKeyMode === "seek"}
              disabled={!arrowKeyControlEnabled}
              label="左右键"
              onState="歌曲内跳转"
              offState="切换歌曲"
              title="左右键在当前歌曲内快退 / 快进，或切换上一首 / 下一首。"
              onChange={() =>
                setHorizontalArrowKeyMode(horizontalArrowKeyMode === "seek" ? "track" : "seek")
              }
            />
            <Switch
              checked={verticalArrowKeyMode === "volume"}
              disabled={!arrowKeyControlEnabled}
              label="上下键"
              onState="音量"
              offState="列表位置"
              title="上下键调整音量，或在当前歌曲列表中向上 / 向下移动。"
              onChange={() =>
                setVerticalArrowKeyMode(verticalArrowKeyMode === "volume" ? "list" : "volume")
              }
            />
          </div>
        </Panel>

        <Panel heading="流媒体播放" dense>
          <div className="kd-djp-groups">
            <div className="kd-djp-switch-list" aria-label="流媒体播放">
              <CycleToggle<Quality>
                label="音质"
                value={settings?.stream_quality ?? "128"}
                options={[
                  { id: "128", text: "128K" },
                  { id: "320", text: "320K" },
                  { id: "flac", text: "FLAC" },
                ]}
                title="在线流媒体播放请求的起始音质；平台、版权或会员不允许时会自动降级。"
                onChange={(next) => void saveSettings({ stream_quality: next }).catch(() => undefined)}
              />
              <CycleToggle
                label="视频画质"
                value={String(settings?.video_playback_max_height ?? 1080)}
                options={[
                  { id: "360", text: "360p" },
                  { id: "480", text: "480p" },
                  { id: "720", text: "720p" },
                  { id: "1080", text: "1080p" },
                  { id: "2160", text: "4K" },
                ]}
                title="视频在线播放画质上限；实际画质仍由平台账号和视频本身决定。"
                onChange={(next) => void saveSettings({
                  video_playback_max_height: Number(next),
                }).catch(() => undefined)}
              />
              <CycleToggle
                label="YouTube 预览"
                value={settings?.youtube_preview_player ?? "kdj"}
                options={[
                  { id: "platform", text: "平台播放器" },
                  { id: "kdj", text: "内置播放器" },
                ]}
                title="默认使用内置播放器；只影响尚未下载的在线视频，下载完成后的本地视频始终使用内置播放器。"
                onChange={(next) => void saveSettings({
                  youtube_preview_player: next,
                }).catch(() => undefined)}
              />
              <CycleToggle
                label="B站预览"
                value={settings?.bilibili_preview_player ?? "kdj"}
                options={[
                  { id: "platform", text: "平台播放器" },
                  { id: "kdj", text: "内置播放器" },
                ]}
                title="默认使用内置播放器；只影响尚未下载的在线视频，下载完成后的本地视频始终使用内置播放器。"
                onChange={(next) => void saveSettings({
                  bilibili_preview_player: next,
                }).catch(() => undefined)}
              />
              <Switch
                checked={settings?.stream_cache_enabled ?? false}
                disabled={!settings || streamCacheBusy}
                label="缓存在线播放"
                title={
                  streamCacheStats?.path
                    ? `完整音频在后台写入 ${streamCacheStats.path}；命中后直接从本地播放。`
                    : "完整音频在后台写入下载目录的 .kdj/stream-cache；命中后直接从本地播放。"
                }
                onChange={() => void toggleStreamCache()}
              />
              <InlineNotice
                text={streamCacheError}
                block
                onDismiss={() => setStreamCacheError("")}
              />
            </div>
            <div className="kd-djp-group">
              <div className="kd-djp-label-row">
                <span className="kd-djp-label">歌词</span>
                <SettingsExpandToggle
                  expanded={lyricsExpanded}
                  onToggle={() => setLyricsExpanded((open) => !open)}
                  label="歌词"
                />
              </div>
              {lyricsExpanded ? (
                <div className="kd-djp-switch-list" aria-label="歌词选项">
                <Switch
                  checked={tryOnlineWhenMissing}
                  label="无歌词时尝试匹配"
                  title="本地 .kdj/lyrics/ 没有歌词时，才按曲名、艺人和时长在线匹配；关闭后只使用本地歌词。在线试听仍按来源 ID 取词。"
                  onChange={() => setTryOnlineWhenMissing(!tryOnlineWhenMissing)}
                />
                <CycleToggle
                  label="搜词引擎"
                  value={enginesMode(lyricsEngines)}
                  options={ENGINE_MODE_OPTIONS}
                  title="点击切换：全部 / 仅网易云 / 仅 QQ / 仅 YouTube Music。至少保留一家。"
                  onChange={(mode) => setLyricsEngines(enginesFromMode(mode))}
                />
                </div>
              ) : null}
            </div>
          </div>
        </Panel>

        <Panel heading="下载源与账号" dense>
          <InlineNotice text={accountsError} block />
          <div className="kd-djp-switch-list" aria-label="下载源与账号">
            {SEARCH_PLATFORMS.map((item) => {
              const enabled = normalizeEnabledPlatforms(settings?.enabled_platforms).includes(
                item.id,
              );
              const account = accountsByPlatform.get(item.id);
              if (!account) return null;
              const current = normalizeEnabledPlatforms(settings?.enabled_platforms);
              return (
                <AccountRow
                  key={item.id}
                  account={account}
                  sourceEnabled={enabled}
                  sourceToggleDisabled={!settings || (enabled && current.length <= 1)}
                  onToggleSource={() => {
                    if (!settings) return;
                    void saveSettings(patchEnabledPlatform(settings, item.id, !enabled)).catch(
                      () => undefined,
                    );
                  }}
                />
              );
            })}
          </div>
        </Panel>

        <Panel heading="存储空间" dense>
          <div className="kd-cache-overview" aria-label="存储空间占用">
            {cacheOverview ? (
              (["media", "waveform", "lyrics", "basic", "logs", "other"] as const).map((category) => (
                <CacheOverviewRow
                  key={category}
                  category={category}
                  stats={cacheOverview[category]}
                  busy={cacheBusy !== null}
                  confirming={cacheConfirm === category}
                  onClear={(next) => void clearCache(next)}
                />
              ))
            ) : cacheError ? null : (
              <div className="kd-cache-overview-loading">正在统计…</div>
            )}
          </div>
          {activityLogSettings ? (
            <CycleToggle<ActivityLogSettings["retention_days"]>
              label="日志自动清理"
              value={activityLogSettings.retention_days}
              options={[
                { id: 7, text: "7 天" },
                { id: 14, text: "14 天" },
                { id: 30, text: "30 天" },
                { id: 90, text: "90 天" },
                { id: 0, text: "手动" },
              ]}
              title="手动模式仍保留 128 MB 安全上限"
              onChange={(next) => void changeActivityLogRetention(next)}
            />
          ) : null}
          <InlineNotice
            text={cacheError}
            block
            onDismiss={() => setCacheError("")}
          />
          <InlineNotice
            text={activityLogSettingsError}
            block
            onDismiss={() => setActivityLogSettingsError("")}
          />
        </Panel>

        <ActivityLogPanel />

        {["darwin", "win32", "linux"].includes(getBridge().platform) ? <FfmpegPanel /> : null}
        {showKdjAiPrompt ? <KdjAiPromptPanel /> : null}
      </div>
    </div>
  );
}
