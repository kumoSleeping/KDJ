import { useState } from "react";
import { LoaderCircle } from "lucide-react";
import type { Track } from "../../types";
import { useManagerMixer } from "../../lib/managerMixer";
import { performanceWaveformAmplitudeScale } from "../../lib/waveformRenderPolicy";
import { Panel } from "../common";
import { ManagerWaveform } from "./ManagerWaveform";
import { usePlayingDeck } from "./usePlayingDeck";

export function NowPlayingWaveformPanel({ track }: { track: Track }) {
  const { control: { side, deck } } = usePlayingDeck(track.id);
  const gain = useManagerMixer(state => state.values.gain);
  const [loading, setLoading] = useState(true);
  const ready = side !== null && deck !== null;
  return <Panel heading="波形" padded={false} dense actions={loading || !ready
    ? <LoaderCircle size={13} className="kd-spin" aria-label="波形加载中" /> : undefined}>
    {ready ? <ManagerWaveform track={track} deck={side} duration={deck.duration || track.duration || 0}
      amplitudeScale={performanceWaveformAmplitudeScale(gain)} playing={deck.playing || deck.desiredPlaying}
      onLoadingChange={setLoading} /> : <div className="kd-manager-scroll-wave" aria-busy="true" />}
  </Panel>;
}
