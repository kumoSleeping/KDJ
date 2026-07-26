import { useEffect, useRef, useState } from "react";
import { FolderOpen, ImagePlus, Pencil, Play, RotateCcw, Star, Trash2 } from "lucide-react";
import { api } from "../../lib/api";
import { getBridge } from "../../lib/bridge";
import { camelotToLabel } from "../../lib/camelot";
import { DASH, formatBpm, formatBytes, formatDate, formatDuration } from "../../lib/format";
import { useLibraryStore } from "../../stores/libraryStore";
import type { Track, TrackPatch } from "../../types";
import { Button, Field, InlineNotice, Panel } from "../common";
import { CamelotWheel } from "./CamelotWheel";
import { HarmonicList } from "./HarmonicList";
import { Waveform } from "./Waveform";
import { CamelotChip, EnergyMeter, playTrack } from "./TrackTable";

/** PlayerBar 播放时广播的位置，用来在节拍网格上画播放头。 */
export const POSITION_EVENT = "kd:position";
export interface PositionDetail {
  trackId: number;
  position: number;
}

/** 后端只收这两种：转码要一整个图像库，而截图是 PNG、网上扒的图是 JPEG，够用了。 */
const COVER_MIME = ["image/jpeg", "image/png"];

/** 标签输入框里认的分隔符。中文逗号和顿号是顺手就会打出来的，别让它们变成标签的一部分。 */
const TAG_SEPARATOR = /[,，、;；\n]/;

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="kd-row" style={{ justifyContent: "space-between", gap: "0.75rem" }}>
      <span className="kd-muted kd-nowrap">{label}</span>
      <span className="kd-truncate" style={{ textAlign: "right" }}>
        {children}
      </span>
    </div>
  );
}

/** 表单草稿。标签在编辑期是一行文本，存的时候才切成数组。 */
interface Draft {
  title: string;
  artist: string;
  album: string;
  genre: string;
  year: string;
  comment: string;
  tags: string;
}

function toDraft(track: Track): Draft {
  return {
    title: track.title,
    artist: track.artist,
    album: track.album,
    genre: track.genre,
    year: track.year,
    comment: track.comment,
    tags: track.tags.join(", "),
  };
}

function splitTags(text: string): string[] {
  const seen = new Set<string>();
  for (const part of text.split(TAG_SEPARATOR)) {
    const tag = part.trim();
    if (tag) seen.add(tag);
  }
  return [...seen].sort();
}

/**
 * 只把**真的改过**的字段放进 patch。
 *
 * 后端那边每个字段的语义是"这次动过没"：原样回传一遍，文件标签就要跟着重写一次，
 * mtime 一变，扫描的增量跳过和别的 DJ 软件的缓存全部作废——用户只是点了一下保存。
 */
function buildPatch(track: Track, draft: Draft): TrackPatch {
  const patch: TrackPatch = {};
  // 显式列出这几个键：`keyof TrackPatch & keyof Draft` 会把 tags 也算进来，
  // 而它在 patch 里是 string[]，在草稿里是一行文本，两边不是同一个东西
  type TextKey = "title" | "artist" | "album" | "genre" | "year" | "comment";
  const text: [TextKey, string, string][] = [
    ["title", draft.title.trim(), track.title],
    ["artist", draft.artist.trim(), track.artist],
    ["album", draft.album.trim(), track.album],
    ["genre", draft.genre.trim(), track.genre],
    ["year", draft.year.trim(), track.year],
    // 备注是给自己看的散文，前后空格不算改动之外的东西，但中间的换行要留着
    ["comment", draft.comment, track.comment],
  ];
  for (const [key, next, current] of text) {
    if (next !== current) patch[key] = next;
  }
  // 用 \u0000 当连接符而不是逗号：标签里可以有逗号，用逗号会把「a,b」这一个标签
  // 和「a」「b」两个标签判成同一串。**必须写成转义**——直接嵌真的 NUL 字节，
  // git 会把整个 .tsx 当二进制，diff 和 grep 就全废了。
  const joined = (list: string[]) => list.join("\u0000");
  const tags = splitTags(draft.tags);
  if (joined(tags) !== joined([...track.tags].sort())) patch.tags = tags;
  return patch;
}

export function TrackDetail({ track }: { track: Track }) {
  const updateTrack = useLibraryStore((state) => state.updateTrack);
  const setCover = useLibraryStore((state) => state.setCover);
  const rereadTags = useLibraryStore((state) => state.rereadTags);
  const removeTrack = useLibraryStore((state) => state.removeTrack);
  const selectTrack = useLibraryStore((state) => state.selectTrack);
  const setFilter = useLibraryStore((state) => state.setFilter);

  const [position, setPosition] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => toDraft(track));
  /**
   * 封面 URL 的 cache-buster。后端给封面带了 `Cache-Control: max-age`，
   * 换完图 URL 不变的话浏览器会一直拿缓存里那张旧的——表现是"换封面没反应"。
   */
  const [coverKey, setCoverKey] = useState("");
  /** 没封面时后端 404。记下来换成一个可以点的占位块，而不是留一个破图标。 */
  const [hasCover, setHasCover] = useState(true);
  const [dropping, setDropping] = useState(false);
  /**
   * 这一栏里所有操作（在文件夹中显示 / 移出曲库 / 评分 / 保存元数据 / 换封面）的失败原因。
   * 就摆在按钮那一排底下——这些操作失败时界面上都是"什么都没发生"，
   * 不说一声用户只会以为按钮点空了。
   */
  const [notice, setNotice] = useState("");
  const coverInput = useRef<HTMLInputElement>(null);

  // 切曲目时把编辑态整个丢掉。**不跟着 track 的字段变**：
  // 后台分析、WS 推来的 library.updated 都会换掉这个对象，
  // 跟着重置的话用户正在输入的半句话会被一次后台刷新抹掉。
  useEffect(() => {
    setEditing(false);
    setDraft(toDraft(track));
    setPosition(null);
    setNotice("");
    setCoverKey("");
    setHasCover(true);
    // eslint 的 exhaustive-deps 会想要整个 track，那正是上面说的不能要的东西
  }, [track.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onPosition = (event: Event) => {
      const detail = (event as CustomEvent<PositionDetail>).detail;
      setPosition(detail.trackId === track.id ? detail.position : null);
    };
    window.addEventListener(POSITION_EVENT, onPosition);
    return () => window.removeEventListener(POSITION_EVENT, onPosition);
  }, [track.id]);

  /**
   * 成功不报喜：
   * 移出曲库连这一栏都没了——做成了的证据本来就在眼前。只有失败要留下来。
   */
  const run = (label: string, action: () => Promise<unknown>) => () => {
    setBusy(true);
    setNotice("");
    action()
      .catch((error: unknown) => setNotice(`${label}失败：${(error as Error).message}`))
      .finally(() => setBusy(false));
  };

  const save = run("保存", async () => {
    const patch = buildPatch(track, draft);
    // 一个字都没动就别发请求：后端会照着 patch 重写文件标签
    if (Object.keys(patch).length === 0) {
      setEditing(false);
      return;
    }
    const result = await updateTrack(track.id, patch);
    setEditing(false);
    // 数据库存住了、文件没写进去（只读 / 被 DJ 软件占着）时必须说出来，
    // 否则用户会以为拖进 Rekordbox 的那份也是新的
    if (result.tag_write_error) {
      setNotice(`已存进曲库，但文件标签没写成：${result.tag_write_error}`);
    }
  });

  const pickCover = (file: File | null | undefined) => {
    if (!file) return;
    // 本地先挡一道：拖张 webp 进来的话，让它在这里说清楚，
    // 比等后端回一句"封面只支持 JPEG / PNG"少一个来回
    if (file.type && !COVER_MIME.includes(file.type)) {
      setNotice(`封面只支持 JPEG / PNG，这张是 ${file.type}`);
      return;
    }
    run("换封面", async () => {
      await setCover(track.id, file);
      setHasCover(true);
      setCoverKey(String(Date.now()));
    })();
  };

  const coverUrl = api.coverUrl(track.id, coverKey);

  return (
    <div className="kd-col" style={{ gap: "0.6rem", padding: "0.7rem" }}>
      <div className="kd-row" style={{ gap: "0.6rem", alignItems: "flex-start" }}>
        <div
          className="kd-cover"
          role="button"
          tabIndex={0}
          aria-label="换封面"
          title="点一下选图，也可以直接把图片拖进来（JPEG / PNG）"
          style={{
            width: 64,
            height: 64,
            cursor: "pointer",
            display: "grid",
            placeItems: "center",
            // 拖到位的提示用中性色描边：红色在这个界面里只给"动作"，不给状态
            borderColor: dropping ? "var(--kd-muted)" : undefined,
          }}
          onClick={() => coverInput.current?.click()}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              coverInput.current?.click();
            }
          }}
          // stopPropagation 是必须的：外层有接收音频文件的拖放区，
          // 不拦住的话拖进来的图片会被当成"要入库的曲目"
          onDragOver={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setDropping(true);
          }}
          onDragLeave={() => setDropping(false)}
          onDrop={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setDropping(false);
            pickCover(event.dataTransfer.files[0]);
          }}
        >
          {hasCover ? (
            <img
              src={coverUrl}
              alt=""
              style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
              // 没封面时后端返回 404
              onError={() => setHasCover(false)}
            />
          ) : (
            <ImagePlus size={18} className="kd-faint" />
          )}
        </div>
        <input
          ref={coverInput}
          type="file"
          accept="image/jpeg,image/png"
          style={{ display: "none" }}
          onChange={(event) => {
            pickCover(event.target.files?.[0]);
            // 清空 value：连着挑同一个文件两次时 change 不会再触发
            event.target.value = "";
          }}
        />
        <div style={{ minWidth: 0 }}>
          <div className="kd-truncate" style={{ fontWeight: 700, fontSize: "var(--kd-size-lg)" }}>
            {track.title || track.filename}
          </div>
          <div className="kd-truncate kd-muted">{track.artist || DASH}</div>
          <div className="kd-truncate kd-faint">{track.album || DASH}</div>
          <div className="kd-row kd-faint" style={{ gap: "0.4rem", fontSize: "var(--kd-size-xs)" }}>
            <span>{track.format.toUpperCase() || DASH}</span>
            {track.bitrate ? <span>{track.bitrate} kbps</span> : null}
            <span>{formatDuration(track.duration)}</span>
            <span>{formatBytes(track.size)}</span>
          </div>
        </div>
      </div>

      <div className="kd-row" style={{ flexWrap: "wrap", gap: "0.3rem" }}>
        <Button size="sm" variant="primary" onClick={() => playTrack(track)}>
          <Play size={12} />
          播放
        </Button>
        {/* 分析和写标签都不再摆按钮：分析由后台自动跑（播放/选中会插队），
            写标签跟着分析一起做。手动按钮只会让人以为"不点就不会发生"。 */}
        <Button
          size="sm"
          variant="ghost"
          iconOnly
          aria-label="在文件夹中显示"
          title="在文件夹中显示"
          disabled={busy}
          // 走 run() 而不是裸调用：以前是 `void window.kumodeck?.revealPath(...)`，
          // 桥接没就位或系统调用失败时被 `?.` 和 `void` 一起吞掉，
          // 表现就是"这个按钮点了没反应"。
          onClick={run("在文件夹中显示", () => getBridge().revealPath(track.path))}
        >
          <FolderOpen size={12} />
        </Button>
        <Button
          size="sm"
          variant="danger"
          iconOnly
          aria-label="移出曲库"
          disabled={busy}
          title="只移出曲库，不删文件"
          onClick={run("移出曲库", () => removeTrack(track.id, false))}
        >
          <Trash2 size={12} />
        </Button>
      </div>

      <InlineNotice text={notice} onDismiss={() => setNotice("")} />

      <Panel
        heading="元数据"
        padded
        dense
        actions={
          editing ? (
            <>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
                取消
              </Button>
              {/* 不用 primary/danger：这一栏的红色已经被「移出曲库」占了，
                  再来一块红的，真正危险的那个按钮就不显眼了 */}
              <Button size="sm" disabled={busy} onClick={save}>
                保存
              </Button>
            </>
          ) : (
            <>
              <Button
                size="sm"
                variant="ghost"
                iconOnly
                aria-label="从文件重读标签"
                title="从文件重读标签：库里空着、文件里其实有的时候用"
                disabled={busy}
                onClick={run("重读标签", () => rereadTags(track.id))}
              >
                <RotateCcw size={12} />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  // 进编辑态才取一次现值：草稿不跟着后台刷新走，
                  // 所以这里是它唯一和真实数据对齐的时机
                  setDraft(toDraft(track));
                  setEditing(true);
                }}
              >
                <Pencil size={12} />
                编辑
              </Button>
            </>
          )
        }
      >
        {editing ? (
          <div className="kd-col" style={{ gap: "0.4rem" }}>
            <Field label="标题">
              <input
                className="kd-input"
                value={draft.title}
                placeholder={track.filename}
                onChange={(event) => setDraft({ ...draft, title: event.target.value })}
              />
            </Field>
            <Field label="艺人">
              <input
                className="kd-input"
                value={draft.artist}
                onChange={(event) => setDraft({ ...draft, artist: event.target.value })}
              />
            </Field>
            <Field label="专辑">
              <input
                className="kd-input"
                value={draft.album}
                onChange={(event) => setDraft({ ...draft, album: event.target.value })}
              />
            </Field>
            <div className="kd-row" style={{ gap: "0.4rem", alignItems: "flex-end" }}>
              <Field label="流派" className="kd-grow">
                <input
                  className="kd-input"
                  value={draft.genre}
                  onChange={(event) => setDraft({ ...draft, genre: event.target.value })}
                />
              </Field>
              {/* 年份是文本不是数字输入框：文件里存的可能是 "2021"，
                  也可能是 "2021-05-17"，用 number 会把日期整个吃掉。
                  说明写在 placeholder 里而不是 hint：hint 挂在输入框下面，
                  和左边没有 hint 的「流派」并排时两个输入框会错开一行高。 */}
              <Field label="年份">
                <input
                  className="kd-input"
                  style={{ width: "7.5rem" }}
                  value={draft.year}
                  placeholder="2021-05-17"
                  onChange={(event) => setDraft({ ...draft, year: event.target.value })}
                />
              </Field>
            </div>
            <Field label="标签">
              <input
                className="kd-input"
                value={draft.tags}
                placeholder="逗号分隔：peak time, vocal, 开场"
                onChange={(event) => setDraft({ ...draft, tags: event.target.value })}
              />
            </Field>
            <Field label="备注">
              <textarea
                className="kd-textarea"
                rows={2}
                value={draft.comment}
                placeholder="这首放在哪个段落、和谁接过、要不要练"
                onChange={(event) => setDraft({ ...draft, comment: event.target.value })}
              />
            </Field>
            <span className="kd-field-hint">
              标题 / 艺人 / 专辑 / 流派 / 年份 会一并写回文件标签；标签和备注只存在曲库里。
            </span>
          </div>
        ) : (
          <div className="kd-col" style={{ gap: "0.2rem", fontSize: "var(--kd-size-sm)" }}>
            {/* 标题 / 艺人 / 专辑 上面那块已经显示过了，这里不重复 */}
            <Row label="流派">{track.genre || DASH}</Row>
            <Row label="年份">{track.year || DASH}</Row>
            <div className="kd-row" style={{ gap: "0.25rem", flexWrap: "wrap", marginTop: "0.15rem" }}>
              {track.tags.length ? (
                track.tags.map((tag) => (
                  // 芯片默认全大写，但标签是用户自己敲的原文，"开场" 旁边跟着
                  // 一个被顶成 PEAK TIME 的词只会让人以为自己打错了
                  <span key={tag} className="kd-chip" style={{ textTransform: "none" }}>
                    {tag}
                  </span>
                ))
              ) : (
                <span className="kd-faint">没有标签</span>
              )}
            </div>
            {track.comment && (
              <p className="kd-muted" style={{ marginTop: "0.3rem", whiteSpace: "pre-wrap" }}>
                {track.comment}
              </p>
            )}
          </div>
        )}
      </Panel>

      <Panel heading="分析" padded dense>
        <div className="kd-stat-grid" data-dense="true" style={{ marginBottom: "0.5rem" }}>
          <div className="kd-stat">
            <div className="kd-stat-label">BPM</div>
            <div className="kd-stat-value">{formatBpm(track.bpm)}</div>
            <div className="kd-stat-hint">
              置信度 {track.bpm_confidence !== null ? `${Math.round(track.bpm_confidence * 100)}%` : DASH}
            </div>
          </div>
          <div className="kd-stat">
            <div className="kd-stat-label">KEY</div>
            <div className="kd-stat-value kd-row" style={{ gap: "0.4rem" }}>
              <CamelotChip code={track.camelot} />
            </div>
            <div className="kd-stat-hint">{track.music_key || camelotToLabel(track.camelot) || DASH}</div>
          </div>
          <div className="kd-stat">
            <div className="kd-stat-label">能量</div>
            <div className="kd-stat-value kd-row" style={{ gap: "0.35rem" }}>
              <EnergyMeter value={track.energy} />
              <span>{track.energy ?? DASH}</span>
            </div>
            <div className="kd-stat-hint">
              {track.rms_db !== null ? `${track.rms_db.toFixed(1)} dBFS` : DASH}
            </div>
          </div>
        </div>

        {/* 只留波形。原来波形下面还有一条"首拍附近 16 秒的拍子网格"，
            但它是由 bpm+first_beat 外推出来的，既不能编辑也不能对齐，看着像装饰，已删。 */}
        <Waveform trackId={track.id} position={position} height={64} />
        <div className="kd-row kd-faint" style={{ marginTop: "0.35rem", fontSize: "var(--kd-size-xs)" }}>
          首拍 {track.first_beat !== null ? `${track.first_beat.toFixed(3)}s` : DASH}
          <span className="kd-toolbar-gap" />
          {track.analyzed_at ? `分析于 ${formatDate(track.analyzed_at)}` : "未分析"}
        </div>
        {track.analysis_error && (
          <p style={{ color: "var(--kd-warn)", marginTop: "0.4rem" }}>{track.analysis_error}</p>
        )}
      </Panel>

      <Panel heading="接下一首" padded dense>
        {/* 放宽筛选之后这里动辄三四十首，不封高度会把下面的面板挤到看不见 */}
        <div className="kd-scroll" style={{ maxHeight: "13rem" }}>
          <HarmonicList track={track} onSelect={selectTrack} />
        </div>
      </Panel>

      <Panel heading="文件" padded dense>
        <div className="kd-col" style={{ gap: "0.2rem", fontSize: "var(--kd-size-sm)" }}>
          {/* 时长/格式/大小已经在顶部标题下那行显示过了，这里不重复 */}
          <Row label="采样率">
            {track.samplerate ? `${(track.samplerate / 1000).toFixed(1)} kHz` : DASH}
            {track.channels ? ` · ${track.channels}ch` : ""}
          </Row>
          <Row label="来源">{track.source_platform || "local"}</Row>
          <Row label="入库">{formatDate(track.added_at)}</Row>
          <Row label="路径">
            <span className="kd-mono kd-faint" title={track.path}>
              {track.path}
            </span>
          </Row>
        </div>
      </Panel>

      <Panel heading="评分" padded dense>
        {/* 评分不进编辑表单：点一下就是一个完整的意思，没有"改一半反悔"这回事 */}
        <div className="kd-row" style={{ gap: "0.15rem" }}>
          {[1, 2, 3, 4, 5].map((value) => (
            <button
              key={value}
              type="button"
              className="kd-btn kd-btn-icon"
              data-variant="ghost"
              data-size="sm"
              aria-label={`${value} 星`}
              // 再点当前星级 = 清零，不然打错了没法撤
              onClick={() =>
                void updateTrack(track.id, { rating: track.rating === value ? 0 : value }).catch(
                  (error: unknown) => setNotice(`评分失败：${(error as Error).message}`),
                )
              }
            >
              <Star
                size={13}
                fill={value <= track.rating ? "var(--kd-theme)" : "none"}
                color={value <= track.rating ? "var(--kd-theme)" : "currentColor"}
              />
            </button>
          ))}
        </div>
      </Panel>

      <Panel
        heading="调号轮"
        padded
        dense
        // 说明文字挪进 title：它只在第一次有用，占一整行不值
        className="kd-relative"
      >
        <div
          style={{ display: "flex", justifyContent: "center" }}
          title="亮起的是能和它接上的调；点任意一格按调筛选曲库"
        >
          <CamelotWheel code={track.camelot} size={168} onPick={(code) => setFilter({ key: code })} />
        </div>
      </Panel>
    </div>
  );
}
