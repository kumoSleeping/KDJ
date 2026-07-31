import { useState } from "react";
import { Plus, Search, Trash2 } from "lucide-react";
import { buildVjQuery, useVjKeywords } from "../../lib/vjKeywords";
import { useScKeywords } from "../../lib/scKeywords";
import type { Track } from "../../types";
import { Button } from "../common";
import { requestExploreSearch, type ExploreSearchPlatform } from "../../lib/vjSearch";

function compactTag(value: string, max = 7): string {
  const chars = Array.from(value);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : value;
}

type ExploreTone = "bili" | "sc";

type KeywordOps = {
  keywords: string[];
  picked: string[];
  withArtist: boolean;
  toggle(word: string): void;
  add(word: string): void;
  remove(word: string): void;
  setWithArtist(value: boolean): void;
};

/**
 * Explore 里上下两块共用的关键词 + 搜索条。
 * tone 决定品牌色（B 站粉 / SoundCloud 橙），platform 决定代搜目标。
 */
function ExploreBlock({
  label,
  tone,
  platform,
  track,
  ops,
}: {
  label: string;
  tone: ExploreTone;
  platform: ExploreSearchPlatform;
  track: Track;
  ops: KeywordOps;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  /** 第一次右键只上膛；再次右键同一个词才删除。 */
  const [armedWord, setArmedWord] = useState("");

  const title = track.title || track.filename;
  const artist = track.artist.trim();
  const active = ops.keywords.filter((word) => ops.picked.includes(word));
  const withArtist = Boolean(artist) && ops.withArtist;
  const query = buildVjQuery(title, artist, active, withArtist);
  const taggedCount = active.length + (withArtist ? 1 : 0);

  const commitAdd = () => {
    if (draft.trim()) ops.add(draft);
    setDraft("");
    setAdding(false);
  };

  return (
    <div className="kd-explore-block" data-tone={tone}>
      <div className="kd-explore-block-label">{label}</div>
      <div className="kd-opts kd-vj-words" data-tone={tone}>
        {artist && (
          <button
            type="button"
            className="kd-opt kd-vj-artist"
            aria-pressed={ops.withArtist}
            title={ops.withArtist ? "取消艺人" : "加上艺人"}
            onClick={() => ops.setWithArtist(!ops.withArtist)}
          >
            @{compactTag(artist)}
          </button>
        )}
        {ops.keywords.map((word) => (
          <button
            key={word}
            type="button"
            className="kd-opt"
            aria-pressed={ops.picked.includes(word)}
            aria-label={armedWord === word ? `再次右键删除 ${word}` : word}
            data-delete-armed={armedWord === word ? "true" : undefined}
            title={
              armedWord === word
                ? `再次右键删除「${word}」`
                : ops.picked.includes(word)
                  ? "取消这个词"
                  : "加上这个词"
            }
            onClick={() => {
              if (armedWord === word) {
                ops.remove(word);
                setArmedWord("");
                return;
              }
              setArmedWord("");
              ops.toggle(word);
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              if (armedWord === word) {
                ops.remove(word);
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
        <Button
          variant="primary"
          size="sm"
          onClick={() => requestExploreSearch(query, platform)}
        >
          <Search size={12} />
          搜索{taggedCount > 0 && `（${taggedCount}）`}
        </Button>
      </div>
    </div>
  );
}

/**
 * Explore：曲目详情里上下两块——上面搜 VJ（B 站），下面搜 SoundCloud。
 *
 * 关键词是可多选的选项，勾完后点「搜索」才发起。
 * 勾选与词表长期保存，描述的是「这个人怎么找素材」。
 */
export function VjSearchPanel({ track }: { track: Track }) {
  const vjKeywords = useVjKeywords((state) => state.keywords);
  const vjPicked = useVjKeywords((state) => state.picked);
  const vjWithArtist = useVjKeywords((state) => state.withArtist);
  const vjToggle = useVjKeywords((state) => state.toggle);
  const vjAdd = useVjKeywords((state) => state.add);
  const vjRemove = useVjKeywords((state) => state.remove);
  const vjSetWithArtist = useVjKeywords((state) => state.setWithArtist);

  const scKeywords = useScKeywords((state) => state.keywords);
  const scPicked = useScKeywords((state) => state.picked);
  const scWithArtist = useScKeywords((state) => state.withArtist);
  const scToggle = useScKeywords((state) => state.toggle);
  const scAdd = useScKeywords((state) => state.add);
  const scRemove = useScKeywords((state) => state.remove);
  const scSetWithArtist = useScKeywords((state) => state.setWithArtist);

  return (
    <div className="kd-explore">
      <ExploreBlock
        label="搜索 VJ"
        tone="bili"
        platform="bilibili"
        track={track}
        ops={{
          keywords: vjKeywords,
          picked: vjPicked,
          withArtist: vjWithArtist,
          toggle: vjToggle,
          add: vjAdd,
          remove: vjRemove,
          setWithArtist: vjSetWithArtist,
        }}
      />
      <ExploreBlock
        label="搜索 SoundCloud"
        tone="sc"
        platform="soundcloud"
        track={track}
        ops={{
          keywords: scKeywords,
          picked: scPicked,
          withArtist: scWithArtist,
          toggle: scToggle,
          add: scAdd,
          remove: scRemove,
          setWithArtist: scSetWithArtist,
        }}
      />
    </div>
  );
}
