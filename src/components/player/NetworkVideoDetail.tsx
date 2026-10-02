import { Fragment, useState } from "react";
import { ExternalLink } from "lucide-react";
import { getBridge } from "../../lib/bridge";
import { formatDuration } from "../../lib/format";
import { makeVideoPreviewTrack } from "../../lib/streamTrack";
import { seekVideoPip, useVideoPip, type VideoPipSession } from "../../lib/videoPip";
import type { Track } from "../../types";
import { Button, InlineNotice, Panel } from "../common";
import { PLATFORM_LABEL } from "../download/MergedGroupRow";
import { DetailPanelStack } from "../library/DetailPanelStack";
import { LyricsDetailPanel } from "./LyricsView";

type NetworkSession = Extract<VideoPipSession, { source: "network" }>;

function PreviewLyrics({ track, session }: { track: Track; session: NetworkSession }) {
  // Network video is not the native audio deck. Never follow or seek the song
  // that happens to remain selected behind the preview.
  const position = useVideoPip(state => state.session === session ? state.position : 0);
  return <LyricsDetailPanel track={track} transport={{ position, seek(at) {
    const current = useVideoPip.getState();
    if (current.active && current.session === session) seekVideoPip(at);
  } }} />;
}

/** Detail panels only: the single shared VideoPipHost continues to own playback. */
export function NetworkVideoDetail({ session, restoreTarget }: {
  session: NetworkSession;
  restoreTarget: HTMLElement | null;
}) {
  const duration = useVideoPip(state => state.session === session ? state.duration : 0);
  const [notice, setNotice] = useState("");
  // Workspace keys this component by platform/video/page. The negative ID is
  // solely for shared lyrics/detail state; it is never loaded into an audio deck
  // or written to the library, and mounting this view starts no second playback.
  const [identity] = useState(() => makeVideoPreviewTrack({
    platform: session.platform,
    key: session.bvid,
    title: session.title || session.bvid,
    artists: session.author ? [session.author] : [],
    album: "",
    duration: duration > 0 ? duration : null,
    cover: session.cover || "",
    max_quality: null,
    vip: false,
    payload: session.platform === "youtube"
      ? { video_id: session.bvid }
      : { bvid: session.bvid, page: session.page },
  }));
  const track = { ...identity, title: session.title || session.bvid, artist: session.author,
    duration: duration > 0 ? duration : null };
  const url = session.platform === "youtube"
    ? `https://www.youtube.com/watch?v=${encodeURIComponent(session.bvid)}`
    : `https://www.bilibili.com/video/${encodeURIComponent(session.bvid)}/?p=${session.page + 1}`;
  const facts = [
    ["标题", session.title],
    ["作者", session.author],
    ["来源", PLATFORM_LABEL[session.platform]],
    ["时长", duration > 0 ? formatDuration(duration) : ""],
    ["分 P", session.platform === "bilibili" && session.page > 0 ? `P${session.page + 1}` : ""],
  ].filter(([, value]) => Boolean(value));

  return <div className="kd-col kd-track-detail" style={{ gap: "0.6rem", padding: "0.7rem" }}>
    <InlineNotice text={notice} onDismiss={() => setNotice("")} />
    <DetailPanelStack restoreTarget={restoreTarget} video>
      <PreviewLyrics key="lyrics" track={track} session={session} />
      <Panel key="information" heading="视频信息" padded dense actions={
        <Button size="sm" variant="ghost" onClick={() => {
          const openExternal = getBridge().openExternal;
          if (!openExternal) { setNotice("当前窗口无法打开原网页"); return; }
          void openExternal(url).catch(error => setNotice(String(error)));
        }}><ExternalLink size={12} />原网页</Button>
      }>
        <dl style={{ display: "grid", gridTemplateColumns: "4em minmax(0,1fr)", gap: "0.35rem 0.6rem", margin: 0 }}>
          {facts.map(([label, value]) => <Fragment key={label}>
            <dt className="kd-muted">{label}</dt>
            <dd style={{ margin: 0, overflowWrap: "anywhere" }}>{value}</dd>
          </Fragment>)}
        </dl>
      </Panel>
    </DetailPanelStack>
  </div>;
}
