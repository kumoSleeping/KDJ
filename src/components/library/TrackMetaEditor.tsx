import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Pencil, RotateCcw, Search, Star, Upload } from "lucide-react";
import { api } from "../../lib/api";
import { DASH, formatDate, isImageTrack } from "../../lib/format";
import { consumeSuppressedCoverClick } from "../../lib/trackDrag";
import { followPlayingTrack, placeTrackMetaEditor, useTrackMetaEditor } from "../../lib/trackMetaEditor";
import { useLibraryStore } from "../../stores/libraryStore";
import type { Track, TrackPatch } from "../../types";
import { Button, Field, InlineNotice } from "../common";
import { FloatingPanelWindow } from "../common/FloatingPanelWindow";
import { CoverImage } from "../common/VinylPlaceholder";
import { COVER_PLATFORM_LABEL, coverPreviewUrl, TrackCoverBox, useTrackCover } from "./trackCover";
import "./TrackMetaEditor.css";

/** 标签输入框里认的分隔符。中文逗号和顿号是顺手就会打出来的，别让它们变成标签的一部分。 */
const TAG_SEPARATOR = /[,，、;；\n]/;

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="kd-row" style={{ justifyContent: "space-between", gap: "0.75rem" }}>
      <span className="kd-muted kd-nowrap">{label}</span>
      <span className="kd-muted kd-truncate" style={{ textAlign: "right" }}>
        {children}
      </span>
    </div>
  );
}

/** 编辑时保留只读文件事实；日常浏览在曲目表对应列中显示。 */
function FileRows({ track }: { track: Track }) {
  return (
    <>
      <Row label="采样率">
        {track.samplerate ? `${(track.samplerate / 1000).toFixed(1)} kHz` : DASH}
        {track.channels ? ` · ${track.channels}ch` : ""}
      </Row>
      <Row label="来源">{track.source_platform || "local"}</Row>
      <Row label="文件创建">{formatDate(track.file_created_at)}</Row>
      <Row label="入库">{formatDate(track.added_at)}</Row>
      <Row label="路径">
        <span className="kd-mono kd-faint" title={track.path}>
          {track.path}
        </span>
      </Row>
    </>
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

/** The strip at the bottom of the viewport the player bar occupies; the editor stays above it. */
function playerBarInset(): number {
  const bar = document.querySelector(".kd-player");
  return bar ? Math.max(0, window.innerHeight - bar.getBoundingClientRect().top) : 0;
}

/**
 * Mounted once for the whole app. Editing a track's Meta happens in this floating window,
 * beside whatever asked for it, so no panel gives up its place to the form.
 */
export function TrackMetaEditorHost() {
  const trackId = useTrackMetaEditor((state) => state.trackId);
  useEffect(followPlayingTrack, []);
  // A wide main window edits in its drawer instead (see TrackMetaEditorDrawer).
  const docked = useTrackMetaEditor((state) => state.docked);
  return trackId === null || docked ? null : <TrackMetaEditorLoader trackId={trackId} />;
}

/** The editor as the body of a drawer: the drawer writes the title and puts it away. */
export function TrackMetaEditorDrawer() {
  const trackId = useTrackMetaEditor((state) => state.trackId);
  // The drawer keeps a closed app on screen while it rolls up; keep showing what it showed.
  const shown = useRef(trackId);
  if (trackId !== null) shown.current = trackId;
  return shown.current === null ? null : <TrackMetaEditorLoader trackId={shown.current} docked />;
}

/** Owns the edited track's record: read fresh when the editor opens, replaced by each write. */
function TrackMetaEditorLoader({ trackId, docked = false }: { trackId: number; docked?: boolean }) {
  const [loaded, setLoaded] = useState<{ track: Track | null; error: string }>({ track: null, error: "" });
  const revision = useRef(0);
  const shownTrack = useRef<Track | null>(null);
  shownTrack.current = loaded.track;
  // The list row changes when something else rewrites the track (an analysis, a rating in the table).
  const listed = useLibraryStore((state) => state.summaryById.get(trackId)?.modified_at);
  useEffect(() => {
    const shown = loaded.track;
    if (shown?.id === trackId && (listed === undefined || listed === shown.modified_at)) return;
    const turn = ++revision.current;
    api.track(trackId).then(
      (track) => {
        if (turn !== revision.current) return;
        const shown = shownTrack.current;
        const editor = useTrackMetaEditor.getState();
        if (shown && shown.id !== track.id && editor.dirty) {
          // The form on screen was edited while the other record was being read: it keeps the editor.
          useTrackMetaEditor.setState({ trackId: shown.id, refused: editor.refused + 1 });
          return;
        }
        setLoaded({ track, error: "" });
      },
      (error: unknown) => {
        if (turn !== revision.current) return;
        // A failed refresh keeps the record already on screen.
        setLoaded((current) => current.track?.id === trackId ? current
          : { track: null, error: `读取曲目失败：${(error as Error).message}` });
      },
    );
    return () => { revision.current += 1; };
    // The draft and the record on screen do not restart the read; only the track or its revision does.
  }, [trackId, listed]); // eslint-disable-line react-hooks/exhaustive-deps
  const onUpdated = useCallback((updated: Track) => {
    // A write that finishes for the track shown before a switch does not replace the new one.
    if (updated.id !== trackId) return;
    revision.current += 1;
    setLoaded({ track: updated, error: "" });
  }, [trackId]);
  const { track, error } = loaded;
  if (!track && !error) return null;
  return <TrackMetaEditorWindow track={track} error={error} onUpdated={onUpdated} docked={docked} />;
}

function TrackMetaEditorWindow({ track, error, onUpdated, docked }: {
  track: Track | null;
  error: string;
  onUpdated(track: Track): void;
  /** In a drawer: only the form, without a window around it. */
  docked: boolean;
}) {
  const content = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const request = useTrackMetaEditor((state) => state.request);
  // Where this window first appears is decided once; afterwards it stays where it is.
  const [start] = useState(() => {
    const { anchor, position } = useTrackMetaEditor.getState();
    return { anchor, position };
  });
  const frame = () => content.current?.closest<HTMLElement>(".kd-internal-window") ?? null;
  const rememberPosition = () => {
    requestAnimationFrame(() => {
      const box = frame()?.getBoundingClientRect();
      if (box) useTrackMetaEditor.getState().setPosition({ left: box.left, top: box.top });
    });
  };
  // Runs after the window's own focus: an editor opens on its first field.
  useEffect(() => {
    (content.current?.querySelector<HTMLElement>("input.kd-input") ?? frame())?.focus({ preventScroll: true });
  }, [track?.id, request]);
  const form = (
      <div
        ref={content}
        className="kd-meta-editor"
        onKeyDown={(event) => {
          // Escape inside a field belongs to that field (an IME composition, a half-typed value);
          // it is not also a request to close the window.
          if (event.key === "Escape" && (event.nativeEvent.isComposing
            || (event.target as Element).closest("input, textarea, select"))) event.stopPropagation();
        }}
      >
        {track
          ? <TrackMetaForm key={track.id} track={track} onUpdated={onUpdated} onBusy={setBusy} />
          : <div className="kd-meta-editor-scroll"><InlineNotice text={error} /></div>}
      </div>
  );
  if (docked) return form;
  return (
    <FloatingPanelWindow
      className="kd-meta-editor-window"
      title="编辑 Meta"
      subtitle={track ? track.title || track.filename : undefined}
      closeLabel="关闭 Meta 编辑"
      busy={busy}
      close={() => { useTrackMetaEditor.getState().close(); }}
      initialPosition={start.position ?? undefined}
      place={(size) => placeTrackMetaEditor(start.anchor, size, {
        width: window.innerWidth,
        floor: window.innerHeight - playerBarInset(),
      })}
      bottomInset={playerBarInset}
      onMoveEnd={rememberPosition}
      onMoveCancel={rememberPosition}
    >
      {form}
    </FloatingPanelWindow>
  );
}

function TrackMetaForm({ track, onUpdated, onBusy }: {
  track: Track;
  onUpdated(track: Track): void;
  onBusy(busy: boolean): void;
}) {
  const updateTrack = useLibraryStore((state) => state.updateTrack);
  const rereadTags = useLibraryStore((state) => state.rereadTags);
  const request = useTrackMetaEditor((state) => state.request);
  const refused = useTrackMetaEditor((state) => state.refused);
  const cover = useTrackCover(track, { onUpdated });
  const { busy, notice, setNotice, run } = cover;
  // The window is asked for in order to edit, so it opens on the form.
  const [editing, setEditing] = useState(true);
  const [draft, setDraft] = useState<Draft>(() => toDraft(track));
  /** A close or a switch to another track that the unsaved draft turned down. */
  const [held, setHeld] = useState(false);
  const coverInput = useRef<HTMLInputElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const coverEditable = !isImageTrack(track.format);

  // 一个字都没动的草稿不拦人：能丢的只有真的改过的内容。
  const dirty = editing && Object.keys(buildPatch(track, draft)).length > 0;
  useEffect(() => { useTrackMetaEditor.getState().setDirty(dirty); }, [dirty]);
  useEffect(() => () => useTrackMetaEditor.getState().setDirty(false), []);
  useEffect(() => {
    onBusy(busy);
    return () => onBusy(false);
  }, [busy, onBusy]);

  const startEditing = () => {
    // 进编辑态才取一次现值：草稿不跟着后台刷新走，
    // 所以这里是它唯一和真实数据对齐的时机
    setDraft(toDraft(track));
    setEditing(true);
  };
  const endEditing = () => {
    setEditing(false);
    setHeld(false);
    cover.resetSearch();
  };

  // Asking to edit a track whose editor is already open returns it to the form.
  const seenRequest = useRef(request);
  useEffect(() => {
    if (seenRequest.current === request) return;
    seenRequest.current = request;
    if (!editing) startEditing();
  }, [request]); // eslint-disable-line react-hooks/exhaustive-deps
  const seenRefused = useRef(refused);
  useEffect(() => {
    if (seenRefused.current === refused) return;
    seenRefused.current = refused;
    setHeld(true);
    titleInput.current?.focus({ preventScroll: true });
  }, [refused]);
  const wasEditing = useRef(editing);
  useEffect(() => {
    if (editing && !wasEditing.current) titleInput.current?.focus({ preventScroll: true });
    wasEditing.current = editing;
  }, [editing]);

  const save = run("保存", async () => {
    const patch = buildPatch(track, draft);
    // 一个字都没动就别发请求：后端会照着 patch 重写文件标签
    if (Object.keys(patch).length === 0) {
      endEditing();
      return;
    }
    const result = await updateTrack(track.id, patch);
    onUpdated(result);
    endEditing();
    // 数据库存住了、文件没写进去（只读 / 被 DJ 软件占着）时必须说出来，
    // 否则用户会以为拖进 Rekordbox 的那份也是新的
    if (result.tag_write_error) {
      setNotice(`已存进曲库，但文件标签没写成：${result.tag_write_error}`);
    }
  });

  const pickFile = () => {
    if (consumeSuppressedCoverClick() || busy || cover.searching) return;
    coverInput.current?.click();
  };

  const summary = (
    <div className="kd-meta-editor-summary">
      <span className="kd-meta-editor-title kd-truncate" title={track.title || track.filename}>
        {track.title || track.filename}
      </span>
      <span className="kd-muted kd-truncate" title={track.artist}>{track.artist || DASH}</span>
      <span className="kd-faint kd-truncate" title={track.album}>{track.album || DASH}</span>
    </div>
  );
  const coverTools = (
    <div className="kd-cover-tools">
      <div className="kd-cover-tools-head">
        <span>封面</span>
        <span className="kd-faint">
          {cover.platforms.length > 0
            ? `在线来源：${cover.platforms.map((platform) => COVER_PLATFORM_LABEL[platform]).join("、")}`
            : "顶部未开启网易云或 QQ"}
        </span>
      </div>
      <div className="kd-row" style={{ flexWrap: "wrap", gap: "0.3rem" }}>
        <Button size="sm" variant="ghost" disabled={busy || cover.searching} onClick={() => coverInput.current?.click()}>
          <Upload size={12} />
          上传图片
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || cover.searching || cover.platforms.length === 0}
          onClick={() => void cover.searchOnline()}
        >
          <Search size={12} />
          {cover.searching ? "匹配中…" : "在线匹配"}
        </Button>
      </div>
    </div>
  );

  return (
    <>
      <input
        ref={coverInput}
        type="file"
        accept="image/jpeg,image/png"
        style={{ display: "none" }}
        onChange={(event) => {
          cover.pickCover(event.target.files?.[0]);
          event.target.value = "";
        }}
      />
      <div className="kd-meta-editor-scroll kd-scroll">
        {(coverEditable || !editing) && (
          <div className="kd-meta-editor-head">
            {coverEditable && (
              <TrackCoverBox
                track={track}
                cover={cover}
                size={72}
                label={editing ? "上传封面" : "编辑封面"}
                title={editing ? "上传图片" : "编辑"}
                onActivate={editing ? pickFile : () => { if (!consumeSuppressedCoverClick() && !busy) startEditing(); }}
              />
            )}
            {editing ? coverTools : summary}
          </div>
        )}
        {editing && coverEditable && cover.candidates.length > 0 && (
          <div className="kd-cover-candidates">
            {cover.candidates.map((candidate) => (
              <button
                key={`${candidate.platform}:${candidate.coverKey}`}
                type="button"
                className="kd-cover-candidate"
                disabled={busy}
                title="采用这张封面"
                onClick={() => void cover.selectCandidate(candidate)}
              >
                <CoverImage
                  className="kd-cover-candidate-image"
                  src={coverPreviewUrl(candidate.source.cover)}
                  alt=""
                  loading="lazy"
                />
                <span className="kd-cover-candidate-copy">
                  <strong>{COVER_PLATFORM_LABEL[candidate.platform]}</strong>
                  <span className="kd-truncate">{candidate.source.title || DASH}</span>
                  <span className="kd-faint kd-truncate">
                    {candidate.source.artists.join(" / ") || DASH}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
        {editing ? (
          <div className="kd-col" style={{ gap: "0.4rem" }}>
            <Field label="标题">
              <input
                ref={titleInput}
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
          <div className="kd-col" style={{ gap: "0.2rem" }}>
            <Row label="流派">{track.genre || DASH}</Row>
            <Row label="年份">{track.year || DASH}</Row>
            {track.tags.length > 0 && (
              <div className="kd-row" style={{ gap: "0.25rem", flexWrap: "wrap", marginTop: "0.15rem" }}>
                {track.tags.map((tag) => (
                  // 芯片默认全大写，但标签是用户自己敲的原文，"开场" 旁边跟着
                  // 一个被顶成 PEAK TIME 的词只会让人以为自己打错了
                  <span key={tag} className="kd-chip" style={{ textTransform: "none" }}>
                    {tag}
                  </span>
                ))}
              </div>
            )}
            {track.comment && (
              <p className="kd-muted" style={{ marginTop: "0.3rem", whiteSpace: "pre-wrap" }}>
                {track.comment}
              </p>
            )}
          </div>
        )}
        <div className="kd-col" style={{ gap: "0.2rem" }}>
          <FileRows track={track} />
        </div>
        <div className="kd-row" style={{ gap: "0.75rem", alignItems: "center" }}>
          <span className="kd-muted kd-nowrap">Rating</span>
          <div className="kd-row" style={{ gap: "0.15rem" }}>
            {[1, 2, 3, 4, 5].map((value) => (
              <button
                key={value}
                type="button"
                className="kd-btn kd-btn-icon"
                data-variant="ghost"
                data-size="sm"
                aria-label={`${value} 星`}
                onClick={() =>
                  void updateTrack(track.id, { rating: track.rating === value ? 0 : value })
                    .then(onUpdated)
                    .catch((error: unknown) => setNotice(`评分失败：${(error as Error).message}`))
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
        </div>
      </div>
      <div className="kd-meta-editor-foot">
        <InlineNotice text={notice} onDismiss={() => setNotice("")} />
        <InlineNotice
          chip="未保存"
          text={held && dirty ? "这首歌的修改还没保存；保存或取消后才能关闭或换一首" : ""}
          onDismiss={() => setHeld(false)}
        />
        <div className="kd-meta-editor-actions">
          {editing ? (
            <>
              <Button size="sm" variant="ghost" disabled={busy} onClick={endEditing}>
                取消
              </Button>
              {/* 编辑器里的并列动作保持中性，避免每次保存都变成整栏的视觉焦点。 */}
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
                onClick={run("重读标签", async () => {
                  onUpdated(await rereadTags(track.id));
                })}
              >
                <RotateCcw size={12} />
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={startEditing}>
                <Pencil size={12} />
                编辑
              </Button>
            </>
          )}
        </div>
      </div>
    </>
  );
}
