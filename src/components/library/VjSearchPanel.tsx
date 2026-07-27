import { useState } from "react";
import { Plus, Search, Trash2 } from "lucide-react";
import { buildVjQuery, useVjKeywords } from "../../lib/vjKeywords";
import type { Track } from "../../types";
import { Button } from "../common";
import { requestVjSearch } from "../workspace/Workspace";

function compactTag(value: string, max = 7): string {
  const chars = Array.from(value);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : value;
}

/**
 * 「搜 VJ（B 站）」：拿当前这首歌去 B 站找可以当画面用的视频。
 *
 * 关键词是**可多选的选项**，不是"点一下就搜"的按钮：一次搜索常常要
 * 好几个词一起限定（比如「官方 + 4K」），点一个搜一次等于每次只能试一个。
 * 勾完之后底下那颗「搜索」才真的发起——搜索是要等网络的动作，
 * 不该由"勾选"这种随手操作触发。
 *
 * 勾选和关键词列表长期保存：它们描述的是
 * **这个人怎么找素材**，常年搜手书的和常年搜现场的是两种用法，
 * 每次开软件重设一遍没有道理。
 */
export function VjSearchPanel({ track }: { track: Track }) {
  const keywords = useVjKeywords((state) => state.keywords);
  const picked = useVjKeywords((state) => state.picked);
  const toggle = useVjKeywords((state) => state.toggle);
  const add = useVjKeywords((state) => state.add);
  const remove = useVjKeywords((state) => state.remove);

  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  /** 第一次右键只上膛；再次右键同一个词才删除。 */
  const [armedWord, setArmedWord] = useState("");

  const title = track.title || track.filename;
  const artist = track.artist.trim();
  // 只把**还在列表里**的勾选算进去，顺序按列表来（不按勾选先后）：
  // 同样几个词，搜出来的结果应该是同一批，不该取决于点的顺序
  const active = keywords.filter((word) => picked.includes(word));
  // 艺人不再做成一个容易忘记打开的开关：有值就永远排在曲名后的第一项。
  const query = buildVjQuery(title, artist, active, true);

  const commitAdd = () => {
    if (draft.trim()) add(draft);
    setDraft("");
    setAdding(false);
  };

  return (
    <div className="kd-col" style={{ gap: "0.5rem" }}>
      <div className="kd-vj-words">
          {artist && (
            <span className="kd-vj-artist-tag" title={artist} aria-label={`艺人：${artist}`}>
              {compactTag(artist)}
            </span>
          )}
          {keywords.map((word) => (
          <span key={word} className="kd-vj-word">
            <button
              type="button"
              aria-pressed={picked.includes(word)}
              aria-label={armedWord === word ? `再次右键删除 ${word}` : word}
              data-delete-armed={armedWord === word ? "true" : undefined}
              title={
                armedWord === word
                  ? `再次右键删除「${word}」`
                  : picked.includes(word)
                    ? "取消这个词"
                    : "加上这个词"
              }
              onClick={() => {
                if (armedWord === word) {
                  remove(word);
                  setArmedWord("");
                  return;
                }
                setArmedWord("");
                toggle(word);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                if (armedWord === word) {
                  remove(word);
                  setArmedWord("");
                } else {
                  setArmedWord(word);
                }
              }}
            >
              <span className="kd-vj-word-label">{word}</span>
              {armedWord === word && <Trash2 className="kd-vj-word-trash" size={12} aria-hidden="true" />}
            </button>
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
              if (event.key === "Enter") {
                event.preventDefault();
                commitAdd();
              }
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
      <div className="kd-vj-actions">
        {/* 搜索紧跟关键词，不再被 column stretch 拉成整栏通宽。 */}
        <Button variant="primary" size="sm" onClick={() => requestVjSearch(query)}>
          <Search size={12} />
          搜索{active.length + (artist ? 1 : 0) > 0 && `（${active.length + (artist ? 1 : 0)}）`}
        </Button>
      </div>
    </div>
  );
}
