import { useState } from "react";
import { Plus, RotateCcw, X } from "lucide-react";
import { buildVjQuery, useVjKeywords } from "../../lib/vjKeywords";
import type { Track } from "../../types";
import { requestVjSearch } from "../workspace/Workspace";

/**
 * 「搜VJ(Bili)」：拿当前这首歌去 B 站找可以当画面用的视频。
 *
 * 点一个关键词 = 把「曲名（+ 艺人）+ 这个词」填进顶上的搜索框、平台切成
 * 只勾哔哩哔哩、直接搜。省掉的是"复制曲名 → 滚到顶上 → 粘贴 → 手打关键词
 * → 取消勾选另外三个平台"这一整套。
 *
 * 关键词可增删，和「带艺人」开关一起长期保存——常年搜手书的和常年搜现场的
 * 是两种用法，每次开软件重设一遍没有道理。
 */
export function VjSearchPanel({ track }: { track: Track }) {
  const keywords = useVjKeywords((state) => state.keywords);
  const withArtist = useVjKeywords((state) => state.withArtist);
  const setWithArtist = useVjKeywords((state) => state.setWithArtist);
  const add = useVjKeywords((state) => state.add);
  const remove = useVjKeywords((state) => state.remove);
  const reset = useVjKeywords((state) => state.reset);

  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  /** 编辑态：亮出每颗词上的删除叉。平时藏着——十几个叉排在一起太吵。 */
  const [editing, setEditing] = useState(false);

  const title = track.title || track.filename;
  const preview = buildVjQuery(title, track.artist, "", withArtist) || title;

  const commitAdd = () => {
    if (draft.trim()) add(draft);
    setDraft("");
    setAdding(false);
  };

  return (
    <div className="kd-col" style={{ gap: "0.5rem" }}>
      {/* 先让人看见"到底会拿什么去搜"：曲名里的 [VDJ] 前缀会被洗掉，
          不显示出来的话用户会以为搜的是完整文件名。 */}
      <div className="kd-faint kd-truncate" style={{ fontSize: "var(--kd-size-xs)" }} title={preview}>
        搜索词：{preview} + 关键词
      </div>

      <label className="kd-row kd-muted" style={{ gap: "0.35rem", fontSize: "var(--kd-size-xs)" }}>
        <input
          type="checkbox"
          checked={withArtist}
          onChange={(event) => setWithArtist(event.target.checked)}
        />
        带上艺人名
        {withArtist && !track.artist && <span className="kd-faint">（这首没有艺人）</span>}
      </label>

      <div className="kd-vj-words">
        {keywords.map((word) => (
          <span key={word} className="kd-vj-word">
            <button
              type="button"
              title={`在 B 站搜「${buildVjQuery(title, track.artist, word, withArtist)}」`}
              onClick={() => requestVjSearch(buildVjQuery(title, track.artist, word, withArtist))}
            >
              {word}
            </button>
            {editing && (
              <button
                type="button"
                className="kd-vj-word-x"
                aria-label={`删掉关键词 ${word}`}
                onClick={() => remove(word)}
              >
                <X size={10} />
              </button>
            )}
          </span>
        ))}

        {adding ? (
          <input
            className="kd-input kd-vj-add"
            autoFocus
            value={draft}
            placeholder="新关键词"
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commitAdd}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitAdd();
              if (event.key === "Escape") {
                setDraft("");
                setAdding(false);
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="kd-vj-word-add"
            aria-label="添加关键词"
            title="添加自己常用的关键词"
            onClick={() => setAdding(true)}
          >
            <Plus size={11} />
          </button>
        )}
      </div>

      <div className="kd-row" style={{ gap: "0.5rem", fontSize: "var(--kd-size-xs)" }}>
        <button type="button" className="kd-linklike" onClick={() => setEditing((v) => !v)}>
          {editing ? "完成" : "管理关键词"}
        </button>
        {editing && (
          <button type="button" className="kd-linklike" onClick={reset} title="恢复成默认那几个词">
            <RotateCcw size={10} /> 恢复默认
          </button>
        )}
      </div>
    </div>
  );
}
