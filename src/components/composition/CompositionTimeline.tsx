import { seconds, compositionUsesSections } from "../../lib/composition";
import { useCompositionClock } from "../../lib/compositionPlayback";
import type { CompositionSegment, CompositionTask, CompositionTimeline as Timeline } from "../../types/composition";

export function CompositionTimeline({ task, timeline, segment }: {
  task: CompositionTask; timeline: Timeline; segment: CompositionSegment;
}) {
  const clock = useCompositionClock();
  const videoDuration = task.video_duration_ms ?? task.video?.duration_ms ?? 0;
  const audioDuration = task.audio_duration_ms ?? task.audio?.duration_ms ?? 0;
  const sourceEnd = segment.source_end_ms ?? audioDuration;
  const duration = timeline.duration_ms;
  const bounded = (time: number) => Math.max(0, Math.min(duration, time));
  const percentage = (time: number) => bounded(time) / duration * 100;
  const mapped = compositionUsesSections(task);
  const currentSection = task.video_sections?.find(s => clock.currentTime * 1000 >= s.video_start_ms && clock.currentTime * 1000 < s.video_start_ms + s.duration_ms);
  const position = !clock.ready ? null : clock.trackId === task.video?.track_id
    ? mapped ? currentSection ? clock.currentTime * 1000 - currentSection.video_start_ms + currentSection.audio_start_ms - segment.source_start_ms : null : clock.currentTime * 1000 + timeline.video_start_ms
    : clock.trackId === task.audio?.track_id
      ? clock.currentTime * 1000 - segment.source_start_ms + timeline.audio_start_ms : null;
  const tracks = [
    { kind: "video", label: "主视频", ranges: mapped ? (task.video_sections ?? []).filter(s => s.audio_start_ms < sourceEnd && s.audio_start_ms+s.duration_ms > segment.source_start_ms).map(s => ({start:s.audio_start_ms-segment.source_start_ms,end:s.audio_start_ms+s.duration_ms-segment.source_start_ms})) : [{start:timeline.video_start_ms,end:timeline.video_start_ms+videoDuration}] },
    { kind: "audio", label: task.audio?.is_video ? "叠加视频" : "音频", ranges: [{start:timeline.audio_start_ms,end:timeline.audio_start_ms+sourceEnd-segment.source_start_ms}] },
  ];
  return <div className="kd-composition-timeline" aria-label="输出时间轴">
    {tracks.map(({ kind, label, ranges }) => <div className="kd-composition-timeline-row" key={kind}>
      <span className="kd-composition-track-name">{label}</span>
      <div className="kd-composition-rail" aria-label={`${label} ${ranges.map(({start,end}) => `${seconds(bounded(start))}–${seconds(bounded(end))}`).join("、")}`}>
        {ranges.map(({start,end},index) => <span key={index} data-kind={kind} title={`${seconds(bounded(start))}–${seconds(bounded(end))}`} style={{ left: `${percentage(start)}%`, width: `${percentage(end) - percentage(start)}%` }} />)}
        {position !== null && <i className="kd-composition-playhead" style={{ left: `${percentage(position)}%` }} />}
      </div>
      <small className="kd-composition-track-range">{ranges.length > 1 ? `${ranges.length} 段` : ranges.length === 1 ? `${seconds(bounded(ranges[0].start))}–${seconds(bounded(ranges[0].end))}` : ""}</small>
    </div>)}
    <div className="kd-composition-time-ticks"><span>{position === null ? "0 s" : seconds(Math.round(bounded(position)))}</span><span>{seconds(duration)}</span></div>
  </div>;
}
