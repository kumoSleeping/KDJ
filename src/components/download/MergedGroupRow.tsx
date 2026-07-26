import { Fragment } from "react";
import { ChevronDown, ChevronRight, Check } from "lucide-react";
import { DASH, formatDuration, thumbUrl } from "../../lib/format";
import type { MergedGroup, Platform, SongSource } from "../../types";

/** 平台在表格里的短标签。混合搜索一行可能同时挂三个来源，全名太挤。 */
export const PLATFORM_LABEL: Record<Platform, string> = {
  wyy: "网易云",
  qqm: "QQ",
  soundcloud: "SC",
  bilibili: "B站",
  local: "本地",
};

export interface MergedGroupRowProps {
  group: MergedGroup;
  /** 当前选中的来源下标（用户可在展开后改）。 */
  sourceIndex: number;
  selected: boolean;
  expanded: boolean;
  /** 挂在某个"包"（歌单/一次搜索）底下时缩进并画导引线。 */
  indent?: boolean;
  /** 包里的最后一行，竖导引线到此为止。 */
  last?: boolean;
  onToggleSelect(): void;
  onToggleExpand(): void;
  onPickSource(index: number): void;
}

function qualityLabel(source: SongSource): string {
  if (!source.max_quality) return DASH;
  return source.max_quality === "flac" ? "FLAC" : `${source.max_quality}K`;
}

export function MergedGroupRow({
  group,
  sourceIndex,
  selected,
  expanded,
  indent = false,
  last = false,
  onToggleSelect,
  onToggleExpand,
  onPickSource,
}: MergedGroupRowProps) {
  const active = group.sources[sourceIndex] ?? group.sources[0];
  const multi = group.sources.length > 1;

  const titleCell = (
    <>
      {/* 小缩略图：一屏几十行，用最小档就够认人，尺寸写死所以不会因为
          图片加载完把整行撑一下。 */}
      <span className="kd-thumb">
        {group.cover && (
          <img
            src={thumbUrl(group.cover)}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={(event) => {
              event.currentTarget.style.display = "none";
            }}
          />
        )}
      </span>
      {group.title}
      {group.in_library && (
        <span className="kd-chip" data-tone="ok" style={{ marginLeft: "0.4rem" }}>
          已入库
        </span>
      )}
    </>
  );

  return (
    <Fragment>
      <tr aria-selected={selected} onClick={onToggleSelect}>
        <td style={{ width: "2rem" }}>
          <input
            type="checkbox"
            checked={selected}
            aria-label={`选择 ${group.title}`}
            onChange={onToggleSelect}
            onClick={(event) => event.stopPropagation()}
          />
        </td>
        <td style={{ width: "1.6rem" }}>
          {multi && (
            <button
              type="button"
              className="kd-btn kd-btn-icon"
              data-variant="ghost"
              data-size="sm"
              aria-label={expanded ? "收起来源" : "展开来源"}
              aria-expanded={expanded}
              onClick={(event) => {
                event.stopPropagation();
                onToggleExpand();
              }}
            >
              {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </button>
          )}
        </td>
        <td className="kd-td-strong" title={group.title}>
          {indent ? (
            <span className="kd-tree-indent kd-truncate" data-last={last ? "true" : undefined}>
              {titleCell}
            </span>
          ) : (
            titleCell
          )}
        </td>
        <td title={group.artists.join(", ")}>{group.artists.join(", ") || DASH}</td>
        <td className="kd-muted" title={group.album}>
          {group.album || DASH}
        </td>
        <td className="kd-td-num">{formatDuration(group.duration)}</td>
        <td>
          <span className="kd-source-dots" title={group.sources.map((s) => PLATFORM_LABEL[s.platform]).join(" / ")}>
            {group.sources.map((source, index) => (
              <i
                key={`${source.platform}:${source.key}`}
                className="kd-source-dot"
                data-platform={source.platform}
                data-active={index === sourceIndex ? "true" : "false"}
              />
            ))}
          </span>
        </td>
        <td className="kd-mono">{active ? PLATFORM_LABEL[active.platform] : DASH}</td>
        <td className="kd-td-num kd-mono">{active ? qualityLabel(active) : DASH}</td>
        <td style={{ width: "3rem" }}>
          {active?.vip && (
            <span className="kd-chip" data-tone="warn">
              VIP
            </span>
          )}
        </td>
      </tr>

      {expanded &&
        group.sources.map((source, index) => (
          <tr key={`${source.platform}:${source.key}`} onClick={() => onPickSource(index)}>
            <td />
            <td />
            <td colSpan={3} className="kd-muted" style={{ paddingLeft: "1.4rem" }}>
              <span className="kd-row" style={{ gap: "0.4rem" }}>
                {index === sourceIndex ? <Check size={12} /> : <span style={{ width: 12 }} />}
                <span className="kd-truncate">{source.title}</span>
                <span className="kd-faint">·</span>
                <span className="kd-truncate kd-faint">{source.artists.join(", ") || DASH}</span>
              </span>
            </td>
            <td className="kd-td-num kd-muted">{formatDuration(source.duration)}</td>
            <td />
            <td className="kd-mono kd-muted">{PLATFORM_LABEL[source.platform]}</td>
            <td className="kd-td-num kd-mono kd-muted">{qualityLabel(source)}</td>
            <td>
              {source.vip && (
                <span className="kd-chip" data-tone="warn">
                  VIP
                </span>
              )}
            </td>
          </tr>
        ))}
    </Fragment>
  );
}
