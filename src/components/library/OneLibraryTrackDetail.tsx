import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FolderOpen, Play, Plus, Search, Upload } from "lucide-react";
import { api } from "../../lib/api";
import { isPlatformEnabled } from "../../lib/enabledPlatforms";
import { formatBpm, formatBytes, formatDuration } from "../../lib/format";
import {
  ONE_LIBRARY_COVER_CONTENT_ATTR,
  ONE_LIBRARY_COVER_DEVICE_ATTR,
  ONE_LIBRARY_COVER_DROP_EVENT,
  ONE_LIBRARY_COVER_TARGET_ATTR,
  type OneLibraryCoverDropDetail,
} from "../../lib/oneLibraryCoverDrag";
import { oneLibraryPlayableTrack } from "../../lib/oneLibraryTrack";
import { playTrack } from "../../lib/playTrack";
import { normalizePriority, normalizeSearchPlatforms } from "../../lib/searchPlatforms";
import {
  consumeSuppressedCoverClick,
  finishTrackDrop,
  isTrackDrag,
  readTrackDragIds,
} from "../../lib/trackDrag";
import { useAppStore } from "../../stores/appStore";
import { usePlaylistStore } from "../../stores/playlistStore";
import { useLibraryStore } from "../../stores/libraryStore";
import type { OneLibraryTarget, OneLibraryTrack, Platform, SongSource, Track } from "../../types";
import { Button, InlineNotice, Panel, PanelStack } from "../common";
import { VinylPlaceholder } from "../common/VinylPlaceholder";
import { TableRating } from "../common/TableRating";
import { TrackDetail } from "./TrackDetail";
import { OneLibraryCueList } from "./OneLibraryCueList";
import { POSITION_EVENT, type PositionDetail } from "./TrackDetail";
import { Waveform } from "./Waveform";

type CoverPlatform = Extract<Platform, "wyy" | "qqm">;
interface CoverCandidate {
  platform: CoverPlatform;
  source: SongSource;
  key: string;
}
const COVER_MIME = ["image/jpeg", "image/png"];
const PLATFORM_LABEL: Record<CoverPlatform, string> = { wyy: "网易云", qqm: "QQ 音乐" };

function coverKey(value: string): string {
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return value.trim();
  }
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="kd-row kd-onelibrary-detail-fact">
      <span className="kd-muted">{label}</span>
      <span className="kd-truncate" title={typeof children === "string" ? children : undefined}>
        {children || "—"}
      </span>
    </div>
  );
}

function ExternalOneLibraryTrackDetail({
  track,
  target,
}: {
  track: OneLibraryTrack;
  target: OneLibraryTarget;
}) {
  const settings = useAppStore((state) => state.settings);
  const devices = usePlaylistStore((state) => state.devices);
  const rateTrack = usePlaylistStore((state) => state.rateTrack);
  const writable = !devices.find((device) => device.path === target.device_path)?.read_only;
  const playable = oneLibraryPlayableTrack(track, target);
  const inputRef = useRef<HTMLInputElement>(null);
  const coverBusyRef = useRef(false);
  const searchEpochRef = useRef(0);
  const [busy, setBusy] = useState(false);
  const [position, setPosition] = useState<number | null>(null);
  const [searching, setSearching] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [hasCover, setHasCover] = useState(true);
  const [version, setVersion] = useState("");
  const [notice, setNotice] = useState("");
  const [candidates, setCandidates] = useState<CoverCandidate[]>([]);

  useEffect(() => {
    setHasCover(true);
    setVersion("");
    setPosition(null);
    setNotice("");
    setCandidates([]);
  }, [target.device_path, track.content_id, track.cover_version]);

  useEffect(() => {
    const onPosition = (event: Event) => {
      const detail = (event as CustomEvent<PositionDetail>).detail;
      setPosition(detail.trackId === playable.id ? detail.position : null);
    };
    window.addEventListener(POSITION_EVENT, onPosition);
    return () => window.removeEventListener(POSITION_EVENT, onPosition);
  }, [playable.id]);

  const platforms = useMemo<CoverPlatform[]>(() => {
    const enabled = new Set(
      normalizeSearchPlatforms(settings?.search_platforms).filter((platform) =>
        isPlatformEnabled(settings, platform),
      ),
    );
    return normalizePriority(settings?.platform_priority ?? [])
      .filter((platform): platform is CoverPlatform => platform === "wyy" || platform === "qqm")
      .filter((platform) => enabled.has(platform));
  }, [settings]);

  const updateCover = useCallback(
    async (load: () => Promise<Blob>, label: string): Promise<boolean> => {
      if (coverBusyRef.current) return false;
      if (!writable) return false;
      coverBusyRef.current = true;
      setBusy(true);
      setNotice("");
      try {
        const blob = await load();
        await api.setOneLibraryCover(target.device_path, track.content_id, blob);
        const nextVersion = String(Date.now());
        setVersion(nextVersion);
        setHasCover(true);
        window.dispatchEvent(new CustomEvent("kd:onelibrary-cover-updated", {
          detail: { devicePath: target.device_path, contentId: track.content_id, version: nextVersion },
        }));
        return true;
      } catch (error: unknown) {
        setNotice(`${label}失败：${(error as Error).message}`);
        return false;
      } finally {
        coverBusyRef.current = false;
        setBusy(false);
      }
    },
    [target.device_path, track.content_id, writable],
  );

  const pickFile = (file: File | null | undefined) => {
    if (!file) return;
    if (file.type && !COVER_MIME.includes(file.type)) {
      setNotice("封面只支持 JPEG / PNG");
      return;
    }
    void updateCover(() => Promise.resolve(file), "换封面");
  };

  useEffect(() => {
    const onDrop = (event: Event) => {
      const detail = (event as CustomEvent<OneLibraryCoverDropDetail>).detail;
      if (
        !writable
        ||
        detail?.targetDevicePath !== target.device_path
        || detail.targetContentId !== track.content_id
      ) return;
      const sourceId = detail.source.ids.find((id) =>
        detail.source.kind === "local"
          || detail.source.devicePath !== target.device_path
          || id !== track.content_id,
      );
      if (sourceId === undefined) {
        setNotice("不能把这首歌的封面拖给自己");
        return;
      }
      void updateCover(
        () => detail.source.kind === "local"
          ? api.coverBlob(sourceId)
          : api.oneLibraryCoverBlob(detail.source.devicePath, sourceId),
        "复用封面",
      );
    };
    window.addEventListener(ONE_LIBRARY_COVER_DROP_EVENT, onDrop);
    return () => window.removeEventListener(ONE_LIBRARY_COVER_DROP_EVENT, onDrop);
  }, [target.device_path, track.content_id, updateCover, writable]);

  const searchCovers = async () => {
    if (busy || searching || platforms.length === 0) return;
    const query = [track.title || track.filename, track.artist, track.album]
      .map((value) => value.trim())
      .filter(Boolean)
      .join(" ");
    if (!query) return;
    const epoch = ++searchEpochRef.current;
    setSearching(true);
    setCandidates([]);
    setNotice("");
    try {
      const result = await api.search({ query, platforms, limit: 6, merge: false, kind: "song" });
      if (epoch !== searchEpochRef.current) return;
      const seen = new Set<string>();
      const next: CoverCandidate[] = [];
      for (const platform of platforms) {
        for (const source of result.per_platform[platform] ?? []) {
          const key = coverKey(source.cover);
          if (!source.cover.trim() || seen.has(key)) continue;
          seen.add(key);
          next.push({ platform, source, key });
          if (next.length === 6) break;
        }
        if (next.length === 6) break;
      }
      if (next.length === 0) {
        const reason = Object.values(result.errors).find(Boolean);
        setNotice(reason ? `没有找到封面：${reason}` : "没有找到可用封面");
      } else if (next.length === 1) {
        await chooseCandidate(next[0]);
      } else {
        setCandidates(next);
      }
    } catch (error: unknown) {
      setNotice(`在线匹配失败：${(error as Error).message}`);
    } finally {
      if (epoch === searchEpochRef.current) setSearching(false);
    }
  };

  const chooseCandidate = async (candidate: CoverCandidate) => {
    const ok = await updateCover(
      () => api.onlineCover(candidate.platform, candidate.source.cover),
      "在线封面",
    );
    if (ok) setCandidates([]);
  };

  const nativeDrop = (event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setDropping(false);
    if (busy) return;
    const file = event.dataTransfer.files[0];
    if (file) {
      pickFile(file);
      return;
    }
    if (!isTrackDrag(event)) return;
    const sourceId = readTrackDragIds(event.dataTransfer)[0];
    finishTrackDrop();
    if (sourceId !== undefined) {
      void updateCover(() => api.coverBlob(sourceId), "复用封面");
    }
  };

  const coverUrl = api.oneLibraryCoverUrl(
    target.device_path,
    track.content_id,
    `${track.cover_version}-${version}`,
  );
  return (
    <div className="kd-scroll kd-djp kd-onelibrary-detail">
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png"
        hidden
        onChange={(event) => {
          pickFile(event.target.files?.[0]);
          event.target.value = "";
        }}
      />
      <PanelStack storageKey="kd-onelibrary-detail-panels">
        <Panel
          key="identity"
          heading={track.title || track.filename}
          dense
          actions={
            <span className="kd-row">
              <Button size="sm" variant="ghost" onClick={() => playTrack(playable)}>
                <Play size={12} /> 播放
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void window.kdj.revealPath(track.path)}>
                <FolderOpen size={12} /> 显示
              </Button>
            </span>
          }
        >
          <div className="kd-row" style={{ alignItems: "flex-start" }}>
            <div
              className="kd-cover kd-cover-edit"
              role={writable ? "button" : undefined}
              tabIndex={writable ? 0 : undefined}
              title={writable ? "点击上传封面，也可拖入图片或曲目" : undefined}
              data-cover-empty={!hasCover ? "true" : undefined}
              data-dropping={dropping ? "true" : undefined}
              {...(writable ? {
                [ONE_LIBRARY_COVER_TARGET_ATTR]: "true",
                [ONE_LIBRARY_COVER_DEVICE_ATTR]: target.device_path,
                [ONE_LIBRARY_COVER_CONTENT_ATTR]: String(track.content_id),
              } : {})}
              style={{ width: 76, height: 76, flex: "0 0 76px" }}
              onClick={() => {
                if (writable && !consumeSuppressedCoverClick() && !busy) inputRef.current?.click();
              }}
              onKeyDown={(event) => {
                if (writable && (event.key === "Enter" || event.key === " ")) inputRef.current?.click();
              }}
              onDragOver={(event) => {
                if (!writable) return;
                event.preventDefault();
                event.stopPropagation();
                event.dataTransfer.dropEffect = "copy";
                setDropping(true);
              }}
              onDragLeave={() => setDropping(false)}
              onDrop={writable ? nativeDrop : undefined}
            >
              {hasCover ? (
                <img
                  src={coverUrl}
                  alt=""
                  draggable={false}
                  style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                  onError={() => setHasCover(false)}
                />
              ) : (
                <VinylPlaceholder />
              )}
              {!hasCover ? <span className="kd-cover-plus"><Plus size={14} /></span> : null}
            </div>
            <div className="kd-grow" style={{ minWidth: 0 }}>
              <Fact label="艺人">{track.artist}</Fact>
              <Fact label="专辑">{track.album}</Fact>
              <Fact label="列表">{target.playlist_name}</Fact>
            </div>
          </div>
          {writable ? <div className="kd-row" style={{ flexWrap: "wrap", gap: "0.3rem" }}>
            <Button size="sm" variant="ghost" disabled={busy || searching} onClick={() => inputRef.current?.click()}>
              <Upload size={12} /> 上传图片
            </Button>
            <Button size="sm" variant="ghost" disabled={busy || searching || platforms.length === 0} onClick={() => void searchCovers()}>
              <Search size={12} /> {searching ? "匹配中…" : "在线匹配"}
            </Button>
          </div> : null}
          <InlineNotice text={notice} onDismiss={() => setNotice("")} />
          {candidates.length > 0 ? (
            <div className="kd-cover-candidates">
              {candidates.map((candidate) => (
                <button key={candidate.key} type="button" disabled={busy} onClick={() => void chooseCandidate(candidate)}>
                  <img src={candidate.source.cover.replace(/^http:/i, "https:")} alt="" />
                  <span>{PLATFORM_LABEL[candidate.platform]}</span>
                </button>
              ))}
            </div>
          ) : null}
        </Panel>
        <Panel key="music" heading="曲目信息" dense>
          <Fact label="BPM">{formatBpm(track.bpm)}</Fact>
          <Fact label="KEY">{track.music_key}</Fact>
          <Fact label="时长">{formatDuration(track.duration)}</Fact>
          <Fact label="流派">{track.genre}</Fact>
          <Fact label="年份">{track.year}</Fact>
          <Fact label="评分">
            <TableRating
              value={track.rating}
              onChange={writable
                ? (rating) => { void rateTrack(track.content_id, rating).catch(() => undefined); }
                : undefined}
            />
          </Fact>
          {track.comment ? <Fact label="备注">{track.comment}</Fact> : null}
        </Panel>
        <Panel key="cues" heading="Cue" dense>
          <Waveform
            trackId={playable.id}
            track={playable}
            position={position}
            duration={track.duration ?? 0}
            cuePoints={track.cue_points}
            height={56}
          />
          <OneLibraryCueList cuePoints={track.cue_points} />
        </Panel>
        <Panel key="file" heading="外置文件" dense>
          <Fact label="设备">{target.device_name}</Fact>
          <Fact label="文件">{track.filename}</Fact>
          <Fact label="大小">{track.size > 0 ? formatBytes(track.size) : "—"}</Fact>
          <Fact label="码率">{track.bitrate ? `${track.bitrate} kbps` : "—"}</Fact>
          <Fact label="采样率">{track.samplerate ? `${(track.samplerate / 1000).toFixed(1)} kHz` : "—"}</Fact>
          <Fact label="路径">{track.path}</Fact>
        </Panel>
      </PanelStack>
    </div>
  );
}

export function OneLibraryTrackDetail({
  track,
  target,
}: {
  track: OneLibraryTrack;
  target: OneLibraryTarget;
}) {
  const linkedInPage = useLibraryStore((state) =>
    track.local_track_id
      ? state.tracks.find((candidate) => candidate.id === track.local_track_id)
        ?? (state.selectedTrack?.id === track.local_track_id ? state.selectedTrack : null)
      : null,
  );
  const [loaded, setLoaded] = useState<Track | null>(null);

  useEffect(() => {
    const localId = track.local_track_id;
    if (!localId || linkedInPage?.id === localId) {
      setLoaded(null);
      return;
    }
    let alive = true;
    void api.track(localId)
      .then((local) => { if (alive) setLoaded(local); })
      .catch(() => { if (alive) setLoaded(null); });
    return () => { alive = false; };
  }, [linkedInPage?.id, track.cover_version, track.local_track_id, track.rating]);

  const linked = linkedInPage ?? loaded;
  if (linked) return <TrackDetail track={linked} />;
  return <ExternalOneLibraryTrackDetail track={track} target={target} />;
}
