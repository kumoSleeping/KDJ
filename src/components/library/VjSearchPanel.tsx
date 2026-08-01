import { useState } from "react";
import { Plus, Search, Trash2 } from "lucide-react";
import { buildVjQuery } from "../../lib/vjKeywords";
import { useExploreKeywords } from "../../lib/exploreKeywords";
import {
  orderedExplorePlatforms,
  useExplorePlatforms,
} from "../../lib/explorePlatforms";
import { requestExploreSearch } from "../../lib/vjSearch";
import type { Track } from "../../types";
import { Button } from "../common";
import { SearchPlatforms } from "../download/SearchBar";

function compactTag(value: string, max = 7): string {
  const chars = Array.from(value);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : value;
}

/**
 * 一键搜索：顶上独立可拖的提供商条 + 预设词 + 一次提交。
 * 提供商勾选/排序与顶栏搜索互不同步。
 */
export function VjSearchPanel({ track }: { track: Track }) {
  const keywords = useExploreKeywords((state) => state.keywords);
  const picked = useExploreKeywords((state) => state.picked);
  const withArtist = useExploreKeywords((state) => state.withArtist);
  const toggle = useExploreKeywords((state) => state.toggle);
  const add = useExploreKeywords((state) => state.add);
  const remove = useExploreKeywords((state) => state.remove);
  const setWithArtist = useExploreKeywords((state) => state.setWithArtist);

  const platforms = useExplorePlatforms((state) => state.platforms);
  const priority = useExplorePlatforms((state) => state.priority);
  const togglePlatform = useExplorePlatforms((state) => state.toggle);
  const reorderPlatforms = useExplorePlatforms((state) => state.reorder);

  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  /** 第一次右键只上膛；再次右键同一个词才删除。 */
  const [armedWord, setArmedWord] = useState("");

  const title = track.title || track.filename;
  const artist = track.artist.trim();
  const active = keywords.filter((word) => picked.includes(word));
  const includeArtist = Boolean(artist) && withArtist;
  const query = buildVjQuery(title, artist, active, includeArtist);
  const taggedCount = active.length + (includeArtist ? 1 : 0);

  const commitAdd = () => {
    if (draft.trim()) add(draft);
    setDraft("");
    setAdding(false);
  };

  const runSearch = () => {
    const ordered = orderedExplorePlatforms(platforms, priority);
    requestExploreSearch(query, ordered);
  };

  return (
    <div className="kd-explore">
      <div className="kd-explore-block">
        <div className="kd-explore-plats">
          <SearchPlatforms
            platforms={platforms}
            onTogglePlatform={togglePlatform}
            priority={priority}
            onReorder={reorderPlatforms}
          />
        </div>
        <div className="kd-opts kd-vj-words">
          {artist && (
            <button
              type="button"
              className="kd-opt kd-vj-artist"
              aria-pressed={withArtist}
              title={withArtist ? "取消艺人" : "加上艺人"}
              onClick={() => setWithArtist(!withArtist)}
            >
              @{compactTag(artist)}
            </button>
          )}
          {keywords.map((word) => (
            <button
              key={word}
              type="button"
              className="kd-opt"
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
              {word}
              {armedWord === word && <Trash2 className="kd-vj-word-trash" size={11} aria-hidden="true" />}
            </button>
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
              加词
            </button>
          )}
        </div>
        <div className="kd-vj-actions">
          <Button variant="primary" size="sm" onClick={runSearch}>
            <Search size={12} />
            搜索{taggedCount > 0 && `（${taggedCount}）`}
          </Button>
        </div>
      </div>
    </div>
  );
}
