import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

import { api } from "../../lib/api";
import type {
  ActivityLogCategory,
  ActivityLogEntry,
  ActivityLogOverview,
} from "../../types";
import { Button, InlineNotice, Panel } from "../common";

const CATEGORIES: ReadonlyArray<{ id: ActivityLogCategory; label: string }> = [
  { id: "network", label: "网络" },
  { id: "analysis", label: "分析异常" },
  { id: "user", label: "本地操作" },
];

function timeLabel(timestamp: string): string {
  const value = new Date(timestamp);
  if (Number.isNaN(value.getTime())) return "--:--:--";
  return value.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function durationLabel(duration: number | undefined): string {
  if (duration === undefined) return "";
  return duration < 1_000 ? `${duration}ms` : `${(duration / 1_000).toFixed(1)}s`;
}

function fullTimeLabel(timestamp: string): string {
  const value = new Date(timestamp);
  if (Number.isNaN(value.getTime())) return timestamp;
  return value.toLocaleString([], { hour12: false });
}

function levelLabel(level: ActivityLogEntry["level"]): string {
  return level === "error" ? "错误" : level === "warn" ? "警告" : "信息";
}

function categoryLabel(category: ActivityLogCategory): string {
  return CATEGORIES.find((item) => item.id === category)?.label ?? category;
}

function LogLine({
  entry,
  selected,
  onSelect,
}: {
  entry: ActivityLogEntry;
  selected: boolean;
  onSelect(): void;
}) {
  const facts = [
    entry.target,
    entry.status ? `HTTP ${entry.status}` : "",
    durationLabel(entry.duration_ms),
    entry.count > 1 ? `×${entry.count}` : "",
  ].filter(Boolean);
  const summary = [entry.action, ...facts].join(" · ");
  return (
    <button
      type="button"
      className="kd-activity-log-line"
      data-level={entry.level}
      data-selected={selected || undefined}
      aria-pressed={selected}
      title={summary}
      onClick={onSelect}
    >
      <time dateTime={entry.timestamp}>{timeLabel(entry.timestamp)}</time>
      <span className="kd-activity-log-level" aria-label={entry.level}>
        {entry.level === "error" ? "ERR" : entry.level === "warn" ? "WRN" : "INF"}
      </span>
      <span className="kd-activity-log-message">
        <strong>{entry.action}</strong>
        {facts.length > 0 ? <span>{facts.join(" · ")}</span> : null}
      </span>
    </button>
  );
}

function LogDetail({ entry }: { entry: ActivityLogEntry }) {
  const fields: Array<[string, string]> = [
    ["时间", fullTimeLabel(entry.timestamp)],
    ["分类", categoryLabel(entry.category)],
    ["级别", levelLabel(entry.level)],
    ["目标", entry.target ?? ""],
    ["状态", entry.status ? `HTTP ${entry.status}` : ""],
    ["耗时", durationLabel(entry.duration_ms)],
    ["次数", entry.count > 1 ? `${entry.count} 次` : ""],
  ];
  const visibleFields = fields.filter(([, value]) => Boolean(value));
  return (
    <section className="kd-activity-log-detail" aria-label="日志详情">
      <div className="kd-activity-log-detail-head">
        <span>详情</span>
        <strong>{entry.action}</strong>
      </div>
      <dl>
        {visibleFields.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {entry.detail ? <p>{entry.detail}</p> : null}
    </section>
  );
}

export function ActivityLogPanel() {
  const [category, setCategory] = useState<ActivityLogCategory>("network");
  const [overview, setOverview] = useState<ActivityLogOverview | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const terminalRef = useRef<HTMLDivElement>(null);
  const followingTailRef = useRef(true);

  const refresh = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      setOverview(await api.activityLogs(category));
      setError("");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      if (manual) setRefreshing(false);
    }
  }, [category]);

  useEffect(() => {
    let disposed = false;
    const run = async () => {
      try {
        const next = await api.activityLogs(category);
        if (!disposed) {
          setOverview(next);
          setError("");
        }
      } catch (nextError) {
        if (!disposed) setError(nextError instanceof Error ? nextError.message : String(nextError));
      }
    };
    void run();
    const timer = window.setInterval(() => void run(), 5_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [category]);

  const networkStatus = overview?.excessive ? "请求偏多" : "频率正常";
  const selectedEntry = overview?.entries.find((entry) => entry.id === selectedId) ?? null;
  // 接口按“最新优先”返回，才能先截取最近 N 条；终端显示则应当从旧到新，
  // 让新日志自然追加在底部。
  const entries = overview ? [...overview.entries].reverse() : [];

  useLayoutEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || !followingTailRef.current) return;
    terminal.scrollTop = terminal.scrollHeight;
  }, [category, entries.at(-1)?.id]);

  return (
    <Panel heading="日志" dense>
      <div className="kd-activity-log">
        <div className="kd-activity-log-toolbar">
          <div className="kd-activity-log-tabs" role="tablist" aria-label="日志分类">
            {CATEGORIES.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={category === item.id}
                onClick={() => {
                  followingTailRef.current = true;
                  setCategory(item.id);
                  setSelectedId(null);
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="kd-activity-log-refresh"
            aria-label="刷新日志"
            title="刷新日志"
            disabled={refreshing}
            onClick={() => void refresh(true)}
          >
            <RefreshCw size={12} className={refreshing ? "kd-spin" : undefined} />
          </Button>
        </div>

        {category === "network" && overview ? (
          <div className="kd-activity-log-rate" data-excessive={overview.excessive || undefined}>
            {overview.excessive ? <AlertTriangle size={12} aria-hidden="true" /> : null}
            <span>{networkStatus}</span>
            <span>近 1 分钟 {overview.network_last_minute} 次</span>
            <span>近 1 小时 {overview.network_last_hour} 次</span>
            {overview.dropped > 0 ? <span>高负载时略过写盘 {overview.dropped} 条</span> : null}
          </div>
        ) : null}

        <div
          ref={terminalRef}
          className="kd-activity-terminal"
          role="log"
          aria-live="polite"
          aria-label={`${CATEGORIES.find((item) => item.id === category)?.label ?? ""}日志`}
          onScroll={(event) => {
            const terminal = event.currentTarget;
            followingTailRef.current =
              terminal.scrollHeight - terminal.scrollTop - terminal.clientHeight <= 12;
          }}
        >
          {entries.map((entry) => (
            <LogLine
              key={entry.id}
              entry={entry}
              selected={selectedId === entry.id}
              onSelect={() => setSelectedId(entry.id)}
            />
          ))}
        </div>
        {selectedEntry ? <LogDetail entry={selectedEntry} /> : null}
        <InlineNotice text={error} block onDismiss={() => setError("")} />
      </div>
    </Panel>
  );
}
