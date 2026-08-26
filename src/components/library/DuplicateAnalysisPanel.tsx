import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, LoaderCircle, RefreshCw, Trash2 } from "lucide-react";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/appStore";
import { useLibraryStore } from "../../stores/libraryStore";
import type { DuplicateAnalysisResult } from "../../types";
import { Button, InlineNotice } from "../common";

function cleanPath(path: string): string {
  let clean = path.replaceAll("\\", "/");
  while (clean.endsWith("/")) clean = clean.slice(0, -1);
  return clean;
}

function baseName(path: string): string {
  const clean = cleanPath(path);
  return clean.slice(clean.lastIndexOf("/") + 1) || clean;
}

function candidateLocation(
  path: string,
  folders: string[],
  all: boolean,
): { label: string; nested: boolean } {
  const clean = cleanPath(path);
  const parent = clean.slice(0, clean.lastIndexOf("/"));
  if (all) return { label: parent, nested: false };
  const matched = folders
    .map(cleanPath)
    .filter((folder) => parent === folder || parent.startsWith(folder + "/"))
    .sort((left, right) => right.length - left.length)[0];
  if (!matched) return { label: parent, nested: false };
  let relative = parent.slice(matched.length);
  while (relative.startsWith("/")) relative = relative.slice(1);
  return {
    label: relative ? baseName(matched) + "/" + relative : baseName(matched),
    nested: Boolean(relative),
  };
}

export function DuplicateAnalysisPanel({
  all,
  folders,
  initialIncludeSubfolders,
}: {
  all: boolean;
  folders: string[];
  initialIncludeSubfolders: boolean;
}) {
  const removeTracks = useLibraryStore((state) => state.removeTracks);
  const [result, setResult] = useState<DuplicateAnalysisResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [includeSubfolders, setIncludeSubfolders] = useState(initialIncludeSubfolders);
  const analysisGeneration = useRef(0);

  const analyze = () => {
    const generation = ++analysisGeneration.current;
    setLoading(true);
    setError("");
    setResult(null);
    setSelected(new Set());
    setDeleteArmed(false);
    void api
      .analyzeDuplicates({ all, folders, include_subfolders: includeSubfolders })
      .then((next) => {
        if (generation !== analysisGeneration.current) return;
        const normalized = {
          ...next,
          missing_tracks: next.missing_tracks ?? [],
          offline_roots: next.offline_roots ?? [],
        };
        setResult(normalized);
        setDeleteArmed(false);
        setSelected(
          new Set(
            normalized.groups.flatMap((group) =>
              group.confidence === "high"
                ? group.candidates
                    .filter((item) => item.track.id !== group.keep_id)
                    .map((item) => item.track.id)
                : [],
            ),
          ),
        );
      })
      .catch((reason: unknown) => {
        if (generation === analysisGeneration.current) setError((reason as Error).message);
      })
      .finally(() => {
        if (generation === analysisGeneration.current) setLoading(false);
      });
  };

  useEffect(() => setIncludeSubfolders(initialIncludeSubfolders), [initialIncludeSubfolders]);
  useEffect(analyze, [all, folders.join("|"), includeSubfolders]);

  const selectedIds = useMemo(() => [...selected], [selected]);
  const effectiveFolders = result?.folders ?? folders;
  const selectedNestedCount =
    result?.groups
      .flatMap((group) => group.candidates)
      .filter(
        (candidate) =>
          selected.has(candidate.track.id) &&
          candidateLocation(candidate.track.path, effectiveFolders, all).nested,
      ).length ?? 0;
  const removeSelected = () => {
    if (selectedIds.length === 0 || busy) return;
    if (!deleteArmed) {
      setDeleteArmed(true);
      return;
    }
    setBusy(true);
    setError("");
    void removeTracks(selectedIds, "trash")
      .then((errors) => {
        const failed = new Set(Object.keys(errors).map(Number));
        setResult((current) =>
          current
            ? {
                ...current,
                groups: current.groups
                  .map((group) => ({
                    ...group,
                    candidates: group.candidates.filter(
                      (item) => !selected.has(item.track.id) || failed.has(item.track.id),
                    ),
                  }))
                  .filter((group) => group.candidates.length > 1),
              }
            : current,
        );
        setSelected(failed);
        setDeleteArmed(false);
        const first = Object.values(errors)[0];
        if (first) setError(failed.size + " 首未能移到回收站：" + first);
      })
      .catch((reason: unknown) => setError((reason as Error).message))
      .finally(() => setBusy(false));
  };

  const releaseMissingTracks = () => {
    const ids = result?.missing_tracks.map((track) => track.id) ?? [];
    if (ids.length === 0 || releasing) return;
    setReleasing(true);
    setError("");
    void removeTracks(ids, "keep")
      .then((errors) => {
        const failed = new Set(Object.keys(errors).map(Number));
        const removed = ids.length - failed.size;
        setResult((current) => current ? {
          ...current,
          scanned: Math.max(0, current.scanned - removed),
          missing_tracks: current.missing_tracks.filter((track) => failed.has(track.id)),
        } : current);
        const first = Object.values(errors)[0];
        if (first) setError(failed.size + " 条失效记录未能释放：" + first);
      })
      .catch((reason: unknown) => setError((reason as Error).message))
      .finally(() => setReleasing(false));
  };

  return (
    <div className="kd-col kd-duplicate-panel">
      <div className="kd-duplicate-controls">
        <div className="kd-duplicate-scope">
          <strong title={effectiveFolders.join(" · ")}>
            {all
              ? "全部曲目"
              : effectiveFolders.length === 1
                ? baseName(effectiveFolders[0])
                : effectiveFolders.length + " 个文件夹"}
          </strong>
          <span>
            {result ? result.scanned + " 首曲目 · " + result.groups.length + " 组重复" : ""}
          </span>
        </div>
        <div className="kd-duplicate-actions">
          {!all ? (
            <label className="kd-check" title="关闭后只比较所选文件夹当前层的曲目">
              <input
                type="checkbox"
                checked={includeSubfolders}
                onChange={(event) => {
                  const next = event.target.checked;
                  useAppStore.setState({ duplicateIncludeSubfolders: next });
                  setIncludeSubfolders(next);
                }}
              />
              包含子文件夹
            </label>
          ) : null}
          <span className="kd-toolbar-gap" />
          <button type="button" className="kd-text-action" disabled={loading} onClick={analyze}>
            {loading ? <LoaderCircle className="kd-spin" size={12} /> : <RefreshCw size={12} />}
            重新分析
          </button>
          <Button
            variant={deleteArmed ? "danger" : "default"}
            size="sm"
            disabled={selectedIds.length === 0 || busy || loading}
            onClick={removeSelected}
            title={
              selectedNestedCount > 0
                ? "将从磁盘移到回收站，其中 " + selectedNestedCount + " 首位于子文件夹"
                : "选中的曲目会从各自所在文件夹移到系统回收站"
            }
          >
            <Trash2 size={12} />
            {deleteArmed ? "确认删除" : "移到回收站"}
            {selectedIds.length > 0 ? " " + selectedIds.length : ""}
          </Button>
        </div>
      </div>
      <InlineNotice text={error} onDismiss={() => setError("")} block />
      {result && result.offline_roots.length > 0 ? (
        <div className="kd-optimization-alert" data-tone="warn">
          <AlertTriangle size={15} />
          <div>
            <strong>有 {result.offline_roots.length} 个曲库位置当前离线</strong>
            <span title={result.offline_roots.join(" · ")}>
              未把这些位置下的曲目标记为失效，避免移动盘断开时误释放。
            </span>
          </div>
        </div>
      ) : null}
      {result && result.missing_tracks.length > 0 ? (
        <div className="kd-optimization-alert" data-tone="danger">
          <AlertTriangle size={15} />
          <div>
            <strong>发现 {result.missing_tracks.length} 条失效曲目记录</strong>
            <span>原文件已被移动或删除。释放只移除曲库记录，不会删除磁盘文件。</span>
            <details>
              <summary>查看失效记录</summary>
              <div className="kd-optimization-missing-list">
                {result.missing_tracks.map((track) => (
                  <div key={track.id} title={track.path}>
                    <strong className="kd-truncate">{track.title || track.filename}</strong>
                    <span className="kd-truncate">{track.path}</span>
                  </div>
                ))}
              </div>
            </details>
          </div>
          <Button variant="danger" size="sm" disabled={releasing} onClick={releaseMissingTracks}>
            {releasing ? <LoaderCircle className="kd-spin" size={12} /> : null}
            一键释放
          </Button>
        </div>
      ) : null}
      <div className="kd-scroll kd-grow">
        {result?.groups.map((group) => (
          <section
            key={group.group_id}
            className="kd-duplicate-group"
            data-confidence={group.confidence}
          >
            <header className="kd-duplicate-summary">
              <div>
                <strong>
                  {group.candidates[0]?.track.title || group.candidates[0]?.track.filename}
                </strong>
                <span
                  className="kd-chip"
                  data-tone={group.confidence === "high" ? "ok" : "warn"}
                >
                  {group.confidence === "high" ? "高置信" : "需确认"}
                </span>
              </div>
              <p>{group.reason}</p>
            </header>
            <div className="kd-duplicate-candidates">
              {group.candidates.map((candidate) => {
                const keep = candidate.track.id === group.keep_id;
                const checked = selected.has(candidate.track.id);
                const location = candidateLocation(candidate.track.path, effectiveFolders, all);
                const depthLabel = all ? "" : location.nested ? "子文件夹" : "当前层";
                return (
                  <div
                    key={candidate.track.id}
                    className="kd-duplicate-row"
                    data-keep={keep || undefined}
                    data-selected={checked || undefined}
                  >
                    {/* 选择热区覆盖复选框和曲目信息；只让用户去点 14px 小方框，
                        在触屏和窄右栏里几乎等于不可选。保留动作仍是独立按钮。 */}
                    <label className="kd-duplicate-choice" data-disabled={keep || undefined}>
                      <input
                        type="checkbox"
                        aria-label={"选择删除 " + candidate.track.filename}
                        disabled={keep}
                        checked={checked}
                        onChange={() =>
                          setSelected((current) => {
                            const next = new Set(current);
                            if (!next.delete(candidate.track.id)) next.add(candidate.track.id);
                            setDeleteArmed(false);
                            return next;
                          })
                        }
                      />
                      <span className="kd-duplicate-track">
                        <strong className="kd-truncate" title={candidate.track.path}>
                          {candidate.track.filename}
                        </strong>
                        <span className="kd-duplicate-quality">{candidate.quality_label}</span>
                        <span className="kd-duplicate-location" title={candidate.track.path}>
                          {depthLabel ? <em>{depthLabel}</em> : null}
                          <span className="kd-truncate">{location.label}</span>
                        </span>
                      </span>
                    </label>
                    <div className="kd-duplicate-keep">
                      {keep ? (
                        <span className="kd-chip" data-tone="ok">
                          <Check size={10} />推荐保留
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="kd-text-action"
                          onClick={() => {
                            const previousKeep = group.keep_id;
                            setResult((current) =>
                              current
                                ? {
                                    ...current,
                                    groups: current.groups.map((item) =>
                                      item.group_id === group.group_id
                                        ? { ...item, keep_id: candidate.track.id }
                                        : item,
                                    ),
                                  }
                                : current,
                            );
                            setSelected((current) => {
                              const next = new Set(current);
                              next.delete(candidate.track.id);
                              if (group.confidence === "high") next.add(previousKeep);
                              setDeleteArmed(false);
                              return next;
                            });
                          }}
                        >
                          设为保留
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
