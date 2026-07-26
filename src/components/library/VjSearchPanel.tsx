import { useState } from "react";
import { Plus, RotateCcw, Search, X } from "lucide-react";
import { buildVjQuery, useVjKeywords } from "../../lib/vjKeywords";
import type { Track } from "../../types";
import { Button } from "../common";
import { requestVjSearch } from "../workspace/Workspace";

/**
 * 「搜 VJ（B 站）」：拿当前这首歌去 B 站找可以当画面用的视频。
 *
 * 关键词是**可多选的选项**，不是"点一下就搜"的按钮：一次搜索常常要
 * 好几个词一起限定（比如「官方 + 4K」），点一个搜一次等于每次只能试一个。
 * 勾完之后底下那颗「搜索」才真的发起——搜索是要等网络的动作，
 * 不该由"勾选"这种随手操作触发。
 *
 * 勾选、关键词列表、「带艺人」开关三样都长期保存：它们描述的是
 * **这个人怎么找素材**，常年搜手书的和常年搜现场的是两种用法，
 * 每次开软件重设一遍没有道理。
 */
export function VjSearchPanel({ track }: { track: Track }) {
  const keywords = useVjKeywords((state) => state.keywords);
  const picked = useVjKeywords((state) => state.picked);
  const toggle = useVjKeywords((state) => state.toggle);
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
  // 只把**还在列表里**的勾选算进去，顺序按列表来（不按勾选先后）：
  // 同样几个词，搜出来的结果应该是同一批，不该取决于点的顺序
  const active = keywords.filter((word) => picked.includes(word));
  const query = buildVjQuery(title, track.artist, active, withArtist);

  const commitAdd = () => {
    if (draft.trim()) add(draft);
    setDraft("");
    setAdding(false);
  };

  return (
    <div className="kd-col" style={{ gap: "0.5rem" }}>
      {/* 先让人看见"到底会拿什么去搜"：曲名里的 [VDJ] 前缀会被洗掉，
          不显示出来的话用户会以为搜的是完整文件名。 */}
      <div className="kd-faint" style={{ fontSize: "var(--kd-size-xs)", lineHeight: 1.5 }}>
        搜索词：<span className="kd-mono">{query}</span>
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
              aria-pressed={picked.includes(word)}
              title={picked.includes(word) ? "取消这个词" : "加上这个词"}
              onClick={() => toggle(word)}
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

      {/* 搜索是这一块唯一的动作，红色归它 */}
      <Button variant="primary" size="sm" onClick={() => requestVjSearch(query)}>
        <Search size={12} />
        搜索{active.length > 0 && ` （${active.length} 个词）`}
      </Button>

      <div className="kd-row" style={{ gap: "0.6rem", fontSize: "var(--kd-size-xs)" }}>
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
