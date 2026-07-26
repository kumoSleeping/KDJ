"""混合搜索：把各平台的搜索结果聚合成"一首歌 = 多个来源"。

实现严格对应 docs/00-architecture.md 第 4 节：
归一化 → 三项加权相似度 → 贪心聚类 → 组排序 → 选 best_source。
"""

from __future__ import annotations

import hashlib
import re
import unicodedata
from difflib import SequenceMatcher
from typing import Iterable

from .models import MergedGroup, SongSource

# 平台优先级的**默认值**（交错遍历 + best_source 选择都用它）。
# 用户在前端拖动平台按钮排出的顺序会随请求传进来，优先于这张表。
PLATFORM_PRIORITY: dict[str, float] = {
    "wyy": 1.0,
    "qqm": 0.95,
    "soundcloud": 0.8,
    "bilibili": 0.5,
    "local": 0.4,
}


def _priority_map(priority: Iterable[str] | None) -> dict[str, float]:
    """请求里的平台顺序 → 分值表；没给就用默认表。

    步长 0.05 只是为了排序，绝对值无意义；请求里没提到的平台
    落回默认分（比如 local 永远垫底）。
    """
    ordered = [p for p in (priority or []) if p]
    if not ordered:
        return PLATFORM_PRIORITY
    table = dict(PLATFORM_PRIORITY)
    for index, platform in enumerate(ordered):
        table[platform] = 1.0 - index * 0.05
    return table

# 判定为同一首歌的阈值
SAME_SONG_THRESHOLD = 0.82

# 噪声词：出现在括号里时整段括号丢掉，散落在标题里时单独抹掉。
# 顺序重要——长短语必须排在它的子串前面（"remastered" 在 "remaster" 前，
# 否则 "remaster" 先匹配掉，剩一个孤零零的 "ed"）。
_NOISE_PHRASES: tuple[str, ...] = (
    "radio edit",
    "extended mix",
    "extended version",
    "original mix",
    "remastered",
    "remaster",
    "instrumental",
    "explicit",
    "acoustic",
    "official",
    "live version",
    "remix",
    "cover",
    "live",
    "feat.",
    "feat",
    "ft.",
    "ft",
    "hq",
    "hd",
    "mv",
    "demo",
    "伴奏",
    "翻自",
    "官方",
    "高清",
    "完整版",
    "未删减",
    "原曲",
    "试听",
    "现场版",
    "纯音乐",
    "无损",
    "动态歌词",
    "歌词版",
)

_CJK = r"一-鿿㐀-䶿぀-ゟ゠-ヿ가-힯"


def _noise_pattern() -> re.Pattern[str]:
    parts: list[str] = []
    for phrase in _NOISE_PHRASES:
        escaped = re.escape(phrase)
        if phrase[0].isascii():
            # ASCII 词必须卡词边界，否则 "live" 会把 "deliver" 打穿。
            # \b 对 "feat." 这种以点结尾的不管用，所以自己写前后不跟字母数字。
            parts.append(rf"(?<![a-z0-9]){escaped}(?![a-z0-9])")
        else:
            parts.append(escaped)
    return re.compile("|".join(parts))


_NOISE_RE = _noise_pattern()

# 成对括号：【】()（）[]，非贪婪，不处理嵌套（歌名里几乎不会出现）
_BRACKET_RE = re.compile(r"【[^【】]*】|\([^()]*\)|（[^（）]*）|\[[^\[\]]*\]")

# 艺人分隔符：/ 、 & , ， ; ； | 以及 feat./ft./vs./with/x（x 必须两侧带空格）
_ARTIST_SPLIT_RE = re.compile(
    r"[/、&,，;；|｜]"
    r"|(?<![a-z0-9])feat\.?(?![a-z0-9])"
    r"|(?<![a-z0-9])ft\.?(?![a-z0-9])"
    r"|(?<![a-z0-9])vs\.?(?![a-z0-9])"
    r"|(?<![a-z0-9])with(?![a-z0-9])"
    r"|\sx\s",
)

_KEEP_RE = re.compile(rf"[^a-z0-9{_CJK}]+")
_TOKEN_RE = re.compile(rf"[a-z0-9]+|[{_CJK}]+")

_UNKNOWN_ARTISTS = frozenset({"unknown", "未知", "未知艺人", "群星", "various", "variousartists"})


# ---------------------------------------------------------------- 归一化


def to_halfwidth(text: str) -> str:
    """全角 → 半角。中文平台的标题里全角括号/空格非常常见。"""
    out: list[str] = []
    for ch in text:
        code = ord(ch)
        if code == 0x3000:
            out.append(" ")
        elif 0xFF01 <= code <= 0xFF5E:
            out.append(chr(code - 0xFEE0))
        else:
            out.append(ch)
    return "".join(out)


def _clean(text: str) -> str:
    """小写 + 全角转半角 + 去括号噪声 + 去散落噪声词，**保留空格**（分词还要用）。"""
    value = unicodedata.normalize("NFKC", str(text or ""))
    value = to_halfwidth(value).lower()

    def _drop_bracket(match: re.Match[str]) -> str:
        inner = match.group(0)[1:-1]
        # 括号里含噪声词 → 整段丢掉；否则只脱掉括号，保留内容
        # （"(Part 2)" 这种是内容不是噪声，丢了会把两首不同的歌合并）。
        return " " if _NOISE_RE.search(inner) else f" {inner} "

    value = _BRACKET_RE.sub(_drop_bracket, value)
    value = _NOISE_RE.sub(" ", value)
    return re.sub(r"\s+", " ", value).strip()


def normalize_title(text: str) -> str:
    """归一化标题：去噪声后再抹掉全部标点与空白，只留字母数字和 CJK。"""
    return _KEEP_RE.sub("", _clean(text))


def title_tokens(text: str) -> frozenset[str]:
    """标题分词。

    normalize_title 把空格也删了，没法直接做集合 Jaccard，所以从"保留空格"的中间结果分词。
    中文没有空格，按字切 token 粒度太粗（"我爱你" vs "你爱我" 会 100% 命中），
    所以 CJK 段落用**二元组**，既保留语序又不需要引入分词库。
    """
    tokens: set[str] = set()
    for chunk in _TOKEN_RE.findall(_clean(text)):
        if chunk[0].isascii():
            tokens.add(chunk)
        elif len(chunk) <= 2:
            tokens.add(chunk)
        else:
            tokens.update(chunk[i : i + 2] for i in range(len(chunk) - 1))
    return frozenset(tokens)


def normalize_artists(artists: Iterable[str] | None) -> frozenset[str]:
    """艺人列表 → 归一化名字集合（拆 `/ 、 & , feat. ft.` 等分隔符）。"""
    out: set[str] = set()
    for raw in artists or ():
        base = to_halfwidth(unicodedata.normalize("NFKC", str(raw or ""))).lower()
        for piece in _ARTIST_SPLIT_RE.split(base):
            name = _KEEP_RE.sub("", piece)
            if name and name not in _UNKNOWN_ARTISTS:
                out.add(name)
    return frozenset(out)


# ---------------------------------------------------------------- 相似度


def jaccard(a: frozenset[str], b: frozenset[str]) -> float:
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def title_similarity(a: str, b: str) -> float:
    """token 集合 Jaccard × 0.5 + 编辑距离比 × 0.5。"""
    ratio = SequenceMatcher(None, normalize_title(a), normalize_title(b)).ratio()
    return jaccard(title_tokens(a), title_tokens(b)) * 0.5 + ratio * 0.5


def artist_similarity(a: Iterable[str] | None, b: Iterable[str] | None) -> float:
    left, right = normalize_artists(a), normalize_artists(b)
    if not left or not right:
        return 0.5  # 任一为空 → 中性，不奖不罚
    return len(left & right) / len(left | right)


def duration_similarity(a: float | None, b: float | None) -> float:
    if a is None or b is None:
        return 0.5
    delta = abs(float(a) - float(b))
    if delta <= 3.0:
        return 1.0
    if delta <= 8.0:
        return 0.6
    return 0.0


def score(a: SongSource, b: SongSource) -> float:
    """两个来源是同一首歌的把握程度，0..1。"""
    return (
        0.6 * title_similarity(a.title, b.title)
        + 0.3 * artist_similarity(a.artists, b.artists)
        + 0.1 * duration_similarity(a.duration, b.duration)
    )


# ---------------------------------------------------------------- 聚合


def _interleave(
    per_platform: dict[str, list[SongSource]],
    table: dict[str, float] | None = None,
) -> list[SongSource]:
    """按各平台原排名交错遍历：先取各平台第 1 名，再各平台第 2 名……

    这样贪心聚类的"先到先成簇"才公平——如果一个平台一口气排完，
    它的第 20 名会先于别家的第 1 名建簇，簇的代表就偏了。
    """
    table = table or PLATFORM_PRIORITY
    platforms = sorted(
        (p for p, items in per_platform.items() if items),
        key=lambda p: (-table.get(p, 0.5), p),
    )
    ordered: list[SongSource] = []
    depth = max((len(per_platform[p]) for p in platforms), default=0)
    for rank in range(depth):
        for platform in platforms:
            items = per_platform[platform]
            if rank < len(items):
                ordered.append(items[rank])
    return ordered


def _best_source_index(sources: list[SongSource], table: dict[str, float] | None = None) -> int:
    """优先有 flac 标记的源，其次平台优先级。"""
    prio = table or PLATFORM_PRIORITY

    def rank(item: tuple[int, SongSource]) -> tuple[int, float, int]:
        index, src = item
        has_flac = 1 if (src.max_quality or "").lower() == "flac" else 0
        return (-has_flac, -prio.get(src.platform, 0.5), index)

    return min(enumerate(sources), key=rank)[0]


def _group_id(sources: list[SongSource]) -> str:
    # 排序后再哈希：同一组的 group_id 不随来源到达顺序变化，前端可以拿它当 React key。
    joined = "|".join(sorted(f"{s.platform}:{s.key}" for s in sources))
    return hashlib.sha1(joined.encode("utf-8")).hexdigest()[:12]


def merge_results(
    query: str,
    per_platform: dict[str, list[SongSource]],
    priority: Iterable[str] | None = None,
) -> list[MergedGroup]:
    """把多平台结果聚合成 MergedGroup 列表（已按相关度降序排好）。

    priority：请求里 platforms 的顺序（用户拖出来的优先级），
    决定交错遍历次序和 best_source 归属。
    """
    table = _priority_map(priority)
    ordered = _interleave(per_platform, table)

    # 组排序用的平台梯队（按用户拖出来的顺序）：
    # - 网易云和 QQ 是同质的音乐库平台，永远共用更靠前那个的位置——
    #   两家之间只按相关度混排，不会出现"上半截全网易云、下半截全 QQ"。
    # - B 站 / SoundCloud 这类特化来源按自己的拖动位置自成梯队：
    #   拖在最后就整块沉底（B 站标题天然含关键词，纯按相关度会霸榜），
    #   拖到前面就整块上浮——位置就是用户的表态。
    order_list = [p for p in (priority or []) if p] or sorted(
        PLATFORM_PRIORITY, key=lambda p: -PLATFORM_PRIORITY[p]
    )
    positions = {p: i for i, p in enumerate(order_list)}
    fallback_tier = len(order_list)

    def tier_of(platform: str) -> int:
        if platform in ("wyy", "qqm"):
            twins = [positions[p] for p in ("wyy", "qqm") if p in positions]
            return min(twins) if twins else fallback_tier
        return positions.get(platform, fallback_tier)

    clusters: list[list[SongSource]] = []
    # 簇代表 = 第一个进簇的来源（先到先成簇），后来者只跟代表比，不做质心更新——
    # 质心会漂移，导致"A 像 B、B 像 C，于是 A 和 C 被并到一起"。
    representatives: list[SongSource] = []
    first_rank: list[int] = []

    for index, source in enumerate(ordered):
        best_i = -1
        best_score = SAME_SONG_THRESHOLD
        for i, rep in enumerate(representatives):
            value = score(rep, source)
            if value >= best_score:
                best_i, best_score = i, value
        if best_i < 0:
            clusters.append([source])
            representatives.append(source)
            first_rank.append(index)
        else:
            clusters[best_i].append(source)

    ranked: list[tuple[float, int, MergedGroup]] = []
    for cluster, rank in zip(clusters, first_rank):
        best_index = _best_source_index(cluster, table)
        best = cluster[best_index]
        platforms = {s.platform for s in cluster}
        # 用**去重后的平台数**而不是 len(sources)：同平台的多个版本（原版/live）
        # 也会落进同一簇，用原始条数会让"某平台重复收录"的歌不合理地排到前面。
        breadth = min(len(platforms), 3) / 3.0
        relevance = title_similarity(query, best.title)
        group = MergedGroup(
            group_id=_group_id(cluster),
            title=best.title,
            artists=list(best.artists) or list(_first_nonempty(cluster, "artists") or []),
            album=best.album or _first_nonempty(cluster, "album") or "",
            duration=best.duration if best.duration is not None else _first_duration(cluster),
            cover=best.cover or _first_nonempty(cluster, "cover") or "",
            sources=list(cluster),
            best_source_index=best_index,
            # score 本身仍只看相关度和跨平台覆盖度；平台的话语权在梯队上
            #（见上面 tier_of）：同梯队内按分数混排，跨梯队整块分层。
            score=round(breadth * 0.4 + relevance * 0.6, 6),
            in_library=False,
        )
        # 分数相同时用"首个成员的原始名次"兜底，保证排序稳定可复现。
        ranked.append((tier_of(best.platform), group.score, rank, group))

    ranked.sort(key=lambda item: (item[0], -item[1], item[2]))
    return [item[3] for item in ranked]


def _first_nonempty(cluster: list[SongSource], attr: str):
    for src in cluster:
        value = getattr(src, attr, None)
        if value:
            return value
    return None


def _first_duration(cluster: list[SongSource]) -> float | None:
    for src in cluster:
        if src.duration is not None:
            return src.duration
    return None


# ---------------------------------------------------------------- 批量投喂拆分


_URL_RE = re.compile(r"https?://[^\s，,、；;）)】\]】]+", re.IGNORECASE)
# 单行输入才按这些符号拆；多行输入只按行拆，理由见 split_intake_text
_INLINE_SEPARATORS = re.compile(r"[,，、;；\t]+")


def interleave_sources(
    per_platform: dict[str, list[SongSource]],
    priority: Iterable[str] | None = None,
) -> list[SongSource]:
    """公开版 _interleave：merge=False 时也要交错，别让结果按平台分块。"""
    return _interleave(per_platform, _priority_map(priority))


def split_intake_text(text: str, *, max_entries: int = 50) -> tuple[list[str], int]:
    """把粘贴进来的一大段文本拆成若干条"关键词或链接"。

    拆分规则（顺序很重要）：

    1. 只要正文里出现换行，就**只按换行拆**。多行粘贴时按逗号再拆会毁掉
       `曲名 - 艺人A, 艺人B` 这种行——艺人名里的逗号非常常见。
    2. 完全没有换行时（单行粘贴），才按 `, ， 、 ; ； Tab` 拆。
    3. 任何一条里如果含 URL，就把 URL 抽出来单独成条：一行里贴了好几个
       分享链接是很常见的粘贴方式。

    返回 (条目, 被 max_entries 截掉的条数)。条目去重且保持原顺序。
    """
    normalized = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    raw_lines = normalized.split("\n") if "\n" in normalized else _INLINE_SEPARATORS.split(normalized)

    entries: list[str] = []
    seen: set[str] = set()

    def push(value: str) -> None:
        cleaned = value.strip().strip("​")
        if not cleaned or cleaned in seen:
            return
        seen.add(cleaned)
        entries.append(cleaned)

    for line in raw_lines:
        urls = _URL_RE.findall(line)
        if urls:
            for url in urls:
                push(url)
            # 链接以外的残余文字（"分享单曲 xxx https://..."）不再当关键词，
            # 那基本都是分享话术，搜出来全是噪声。
            continue
        push(line)

    if len(entries) <= max_entries:
        return entries, 0
    return entries[:max_entries], len(entries) - max_entries


def is_url(entry: str) -> bool:
    return bool(_URL_RE.match(entry.strip()))
